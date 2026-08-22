import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprintHostedTaskCommand } from './protocol.js'
import { HostedTaskMutationWal, type HostedMutationIntent } from './HostedTaskMutationWal.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('HostedTaskMutationWal', () => {
  test('supports a normal owner-owned team directory while rejecting writable and symlinked directories', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'hosted-wal-directory-')); roots.push(parent)
    const teamDirectory = join(parent, 'team'); await mkdir(teamDirectory, { mode: 0o755 })
    const teamId = `team_${'0'.repeat(32)}`
    expect(await new HostedTaskMutationWal(teamDirectory, teamId).withFence(async () => 'compatible')).toBe('compatible')
    await chmod(teamDirectory, 0o777)
    await expect(new HostedTaskMutationWal(teamDirectory, teamId).withFence(async () => 'unsafe')).rejects.toThrow('Unsafe hosted WAL directory')
    await chmod(teamDirectory, 0o755)
    const link = join(parent, 'team-link'); await symlink(teamDirectory, link)
    await expect(new HostedTaskMutationWal(link, teamId).withFence(async () => 'unsafe')).rejects.toThrow()
  })

  test('persists ambiguous intent and exact terminal receipt across instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-wal-test-'))
    roots.push(root)
    const scope = { teamId: `team_${'1'.repeat(32)}`, sourceGeneration: 'generation_test', idempotencyKey: 'i' }
    const wal = new HostedTaskMutationWal(root, scope.teamId)
    const receipt = { schemaVersion: 1 as const, outcome: 'committed' as const, commandId: 'command_c', teamId: scope.teamId, sourceGeneration: scope.sourceGeneration, revision: 'revision_next', affectedTaskIds: [] }
    const authority = { actorId: 'actor', deploymentId: 'deployment', bootId: 'boot', restoreGeneration: 1, workspaceId: 'workspace', mountBinding: { mountGeneration: 1, declaredRootHash: 'b'.repeat(64) }, teamId: scope.teamId }
    const command = { schemaVersion: 1 as const, kind: 'create_task' as const, commandId: 'command_c', idempotencyKey: scope.idempotencyKey, teamId: scope.teamId, expectedSourceGeneration: scope.sourceGeneration, expectedRevision: 'revision_before', subject: 'Subject', description: null, status: 'pending' as const, ownerId: null, column: 'todo' as const, order: 0 }
    const fingerprint = fingerprintHostedTaskCommand(command)
    const result = { kind: 'committed' as const, currentSourceGeneration: scope.sourceGeneration, payloadFingerprint: fingerprint, receipt }
    const ledgerText = '{"schemaVersion":2,"entries":{}}'; const ledgerImage = { existed: true, sha256: createHash('sha256').update(ledgerText).digest('hex'), contentBase64: Buffer.from(ledgerText).toString('base64') }
    let intent!: HostedMutationIntent
    expect(await wal.withFence(async () => { intent = await wal.appendIntent({ scope, commandId: 'command_c', payloadFingerprint: fingerprint, expectedRevision: 'revision_before', committedResult: result, writes: [{ target: 'ledger', before: { existed: false, sha256: null, contentBase64: null }, after: ledgerImage }], directories: { team: [1, 2], tasks: [1, 3] }, taskMembership: [], rosterGuard: 'a'.repeat(64), authority, command, canonicalScope: { claudeRoot: root, teamDirectory: root, tasksDirectory: root } }); return true })).toBe(true)
    expect((await new HostedTaskMutationWal(root, scope.teamId).lookup(scope)).kind).toBe('ambiguous')
    await wal.withFence(async () => wal.appendTerminal(intent.walId, result))
    expect(await new HostedTaskMutationWal(root, scope.teamId).lookup(scope)).toEqual({ kind: 'terminal', intent, result })
    const validState = JSON.parse(await readFile(wal.path, 'utf8')) as Record<string, unknown>
    const malformed = structuredClone(validState); malformed.unexpected = true
    await writeFile(wal.path, JSON.stringify(malformed), { mode: 0o600 })
    await expect(new HostedTaskMutationWal(root, scope.teamId).lookup(scope)).rejects.toThrow('terminal keys')
    const invalidLayout = structuredClone(validState) as { intent: { writes: unknown[] } }
    invalidLayout.intent.writes.push(structuredClone(invalidLayout.intent.writes[0]))
    await writeFile(wal.path, JSON.stringify(invalidLayout), { mode: 0o600 })
    await expect(new HostedTaskMutationWal(root, scope.teamId).lookup(scope)).rejects.toThrow('write layout')
  })

  test('never takes an expired fence from a live PID, even for another process instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-wal-fence-')); roots.push(root); await mkdir(root, { recursive: true })
    const teamId = `team_${'2'.repeat(32)}`; const wal = new HostedTaskMutationWal(root, teamId, 'owner_session_new')
    await writeFile(wal.fencePath, JSON.stringify({ schemaVersion: 1, teamId, nonce: 'live', pid: process.pid, processInstanceId: 'owner_session_other', acquiredAtMs: Date.now() - 6_000 }), { mode: 0o600 })
    expect(await wal.withFence(async () => 'stolen')).toBeUndefined()
  })

  test('takes over only an expired fence whose recorded process is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-wal-dead-fence-')); roots.push(root); await mkdir(root, { recursive: true })
    const teamId = `team_${'2'.repeat(32)}`; const wal = new HostedTaskMutationWal(root, teamId, 'owner_session_new')
    await writeFile(wal.fencePath, JSON.stringify({ schemaVersion: 1, teamId, nonce: 'dead', pid: 2_147_483_647, processInstanceId: 'owner_session_dead', acquiredAtMs: 0 }), { mode: 0o600 })
    expect(await wal.withFence(async () => 'recovered')).toBe('recovered')
    await writeFile(wal.fencePath, '{ambiguous', { mode: 0o600 })
    expect(await wal.withFence(async () => 'unsafe')).toBeUndefined()
  })

  test('detects fence path substitution while the mutation owns its lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-wal-substitute-')); roots.push(root)
    const wal = new HostedTaskMutationWal(root, `team_${'3'.repeat(32)}`)
    expect(await wal.withFence(async () => {
      expect(await wal.ownsActiveFence()).toBe(true)
      await rm(wal.fencePath, { force: true }); await writeFile(wal.fencePath, JSON.stringify({ teamId: 'attacker', nonce: 'attacker', pid: process.pid, acquiredAtMs: Date.now() }))
      return wal.ownsActiveFence()
    })).toBe(false)
  })

  test('does not unlink a copied replacement fence during release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-wal-copied-fence-')); roots.push(root)
    const wal = new HostedTaskMutationWal(root, `team_${'4'.repeat(32)}`)
    await wal.withFence(async () => {
      const contents = await readFile(wal.fencePath)
      await rm(wal.fencePath)
      await writeFile(wal.fencePath, contents, { mode: 0o600 })
      expect(await wal.ownsActiveFence()).toBe(false)
    })
    expect(await readFile(wal.fencePath, 'utf8')).toContain('processInstanceId')
  })

  test('rejects oversized WAL files and non-private WAL layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-wal-safety-')); roots.push(root)
    const teamId = `team_${'5'.repeat(32)}`; const wal = new HostedTaskMutationWal(root, teamId)
    await writeFile(wal.path, Buffer.alloc(8 * 1024 * 1024 + 1), { mode: 0o600 })
    await expect(wal.lookup({ teamId, sourceGeneration: 'generation_x', idempotencyKey: 'x' })).rejects.toThrow('8MiB')
    await writeFile(wal.path, '{}', { mode: 0o644 })
    await chmod(wal.path, 0o644)
    await expect(wal.lookup({ teamId, sourceGeneration: 'generation_x', idempotencyKey: 'x' })).rejects.toThrow('Unsafe hosted WAL')
    await chmod(wal.path, 0o600); await chmod(root, 0o777)
    await expect(wal.lookup({ teamId, sourceGeneration: 'generation_x', idempotencyKey: 'x' })).rejects.toThrow('Unsafe hosted WAL directory')
  })
})
