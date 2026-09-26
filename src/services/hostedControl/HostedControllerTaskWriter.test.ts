import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeCommandOutput,
  failClosedHostedTaskWriter,
  HOSTED_TASK_COMMAND_FLAG,
  HostedControllerTaskWriter,
  type HostedTaskCommandDiagnostic,
} from './HostedControllerTaskWriter.js'
import {
  assertNoPreparedRetiredOwnerTaskMutation,
  HostedOwnerTaskWalPreparedError,
} from './HostedOwnerTaskWalRetirement.js'
import {
  fingerprintHostedTaskCommand,
  type HostedControlStableAuthority,
  type HostedTaskMutationCommand,
  type HostedTaskMutationRequest,
} from './protocol.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const authority: HostedControlStableAuthority = {
  deploymentId: `deployment_${'3'.repeat(32)}`,
  bootId: `boot_${'4'.repeat(32)}`,
  restoreGeneration: 2,
  workspaceId: `workspace_${'1'.repeat(32)}`,
  mountBinding: { mountGeneration: 5, declaredRootHash: 'a'.repeat(64) },
  teamId: `team_${'c'.repeat(32)}`,
}
const command: HostedTaskMutationCommand = {
  schemaVersion: 1,
  kind: 'update_status',
  commandId: 'command_writer-test',
  idempotencyKey: 'writer:test',
  teamId: authority.teamId,
  expectedSourceGeneration: `generation_${'e'.repeat(64)}`,
  expectedRevision: `revision_${'f'.repeat(64)}`,
  taskId: `task_${'d'.repeat(32)}`,
  status: 'completed',
}
const request: HostedTaskMutationRequest = {
  schemaVersion: 2,
  exchangeId: `task-request_${'2'.repeat(32)}`,
  operation: 'task_mutate',
  ownerBinding: {
    ownerAuthority: 'owner-authority_writer',
    ownerGeneration: 1,
    ownerSessionId: 'owner-session_writer',
    socketIdentity: { device: '1', inode: '2', uid: 501, gid: 20, mode: 0o600 },
  },
  authority: { actorId: 'actor_writer', ...authority },
  payload: { command, payloadFingerprint: fingerprintHostedTaskCommand(command) },
  ownerProof: '',
}
const committed = {
  kind: 'committed',
  currentSourceGeneration: command.expectedSourceGeneration,
  payloadFingerprint: request.payload.payloadFingerprint,
  receipt: {
    schemaVersion: 1,
    outcome: 'committed',
    commandId: command.commandId,
    teamId: command.teamId,
    sourceGeneration: command.expectedSourceGeneration,
    revision: `revision_${'1'.repeat(64)}`,
    affectedTaskIds: [command.taskId],
  },
}

const STUB = join(import.meta.dir, 'fixtures', 'hostedTaskCommandStub.cjs')

async function fixture(mode: Record<string, unknown>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-task-writer-')))
  roots.push(root)
  const entry = STUB
  await writeFile(join(root, 'mode.json'), JSON.stringify(mode))
  const diagnostics: HostedTaskCommandDiagnostic[] = []
  const writer = new HostedControllerTaskWriter({
    command: process.execPath,
    entry,
    claudeRoot: root,
    legacyKey: 'writer-team',
    authority,
    isCurrent: () => true,
    home: root,
    answerDeadlineMs: 1_500,
    reportDiagnostic: diagnostic => { diagnostics.push(diagnostic) },
  })
  const seen = async () => JSON.parse(await readFile(join(root, 'seen.json'), 'utf8')) as {
    argv: string[]; env: string[]; cwd: string; input: Record<string, unknown>
  }
  return { root, writer, diagnostics, seen, setMode: (next: Record<string, unknown>) => writeFile(join(root, 'mode.json'), JSON.stringify(next)) }
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`

describe('HostedControllerTaskWriter', () => {
  test('passes the command to the controller and returns its committed result and self-writes', async () => {
    const effects = [{ fileKey: 'task-1', expectedChecksum: 'b'.repeat(64) }]
    const { writer, seen, root } = await fixture({ stdout: line({ schemaVersion: 1, result: committed, selfWriteEffects: effects }) })

    expect(await writer.mutateWithSelfWriteEffects(request)).toEqual({ result: committed as never, selfWriteEffects: effects })
    const call = await seen()
    expect(call.argv).toEqual([HOSTED_TASK_COMMAND_FLAG])
    expect(call.cwd).toBe(root)
    // Nothing of the Owner's environment reaches the Product-built command.
    expect(call.env.filter(key => !['PWD', 'SHLVL', '_'].includes(key))).toEqual(['AGENT_TEAMS_MCP_CLAUDE_DIR', 'HOME', 'PATH'])
    expect(call.input).toEqual({
      schemaVersion: 1,
      kind: 'hosted_task_command',
      teamName: 'writer-team',
      board: {
        deploymentId: authority.deploymentId,
        bootId: authority.bootId,
        workspaceId: authority.workspaceId,
        mountGeneration: 5,
        teamId: authority.teamId,
      },
      lead: { name: 'team-lead', sessionId: null },
      lockTimeoutMs: 3_000,
      payloadFingerprint: request.payload.payloadFingerprint,
      command,
    })
  })

  test('answers unavailable for a failing or malformed command without passing its output on', async () => {
    const failing = await fixture({ exit: 3 })
    expect(await failing.writer.mutateWithSelfWriteEffects(request)).toEqual({ result: { kind: 'unavailable', retryAfterMs: 1_000 }, selfWriteEffects: [] })
    expect(failing.diagnostics).toEqual([{ stage: 'exit', exitCode: 3, stderrBytes: 0 }])

    const malformed = await fixture({ stdout: line({ schemaVersion: 1, result: committed }) })
    expect((await malformed.writer.mutateWithSelfWriteEffects(request)).result).toEqual({ kind: 'unavailable', retryAfterMs: 1_000 })
    expect(malformed.diagnostics).toEqual([{ stage: 'output' }])
  })

  test('lets a command that outlives the deadline finish and refuses the next one until it does', async () => {
    const stale = { schemaVersion: 1, result: { kind: 'stale_revision', currentSourceGeneration: command.expectedSourceGeneration, currentRevision: `revision_${'2'.repeat(64)}` }, selfWriteEffects: [] }
    const { writer, diagnostics, root, setMode } = await fixture({ delayMs: 2_500, stdout: line(stale) })

    expect((await writer.mutateWithSelfWriteEffects(request)).result).toEqual({ kind: 'unavailable', retryAfterMs: 1_000 })
    expect(diagnostics).toEqual([{ stage: 'deadline' }])
    expect((await writer.mutateWithSelfWriteEffects(request)).result).toEqual({ kind: 'unavailable', retryAfterMs: 1_000 })

    await Bun.sleep(1_500)
    await setMode({ stdout: line(stale) })
    expect((await writer.mutateWithSelfWriteEffects(request)).result.kind).toBe('stale_revision')
    expect(JSON.parse(await readFile(join(root, 'seen.json'), 'utf8')).argv).toEqual([HOSTED_TASK_COMMAND_FLAG])
  })

  test('never starts the command for a foreign authority or after the Owner lost the team', async () => {
    const { writer, root } = await fixture({ stdout: line({ schemaVersion: 1, result: committed, selfWriteEffects: [] }) })
    const foreign = { ...request, authority: { ...request.authority, restoreGeneration: 3 } }
    expect(await writer.mutateWithSelfWriteEffects(foreign)).toEqual({ result: { kind: 'unavailable' }, selfWriteEffects: [] })

    const lost = new HostedControllerTaskWriter({ command: process.execPath, entry: STUB, claudeRoot: root, legacyKey: 'writer-team', authority, isCurrent: () => false })
    expect(await lost.mutateWithSelfWriteEffects(request)).toEqual({ result: { kind: 'unsafe_active' }, selfWriteEffects: [] })
    expect(await readFile(join(root, 'seen.json'), 'utf8').catch(() => null)).toBeNull()
  })

  test('decodes only one exact output line with self-writes on a committed result', () => {
    const effect = { fileKey: 'task-1', expectedChecksum: 'b'.repeat(64) }
    expect(() => decodeCommandOutput(`${line({ schemaVersion: 1, result: committed, selfWriteEffects: [] })}${line({})}`)).toThrow()
    expect(() => decodeCommandOutput(line({ schemaVersion: 1, result: { kind: 'not_found' }, selfWriteEffects: [effect] }))).toThrow()
    expect(() => decodeCommandOutput(line({ schemaVersion: 1, result: committed, selfWriteEffects: [effect, effect] }))).toThrow()
    expect(() => decodeCommandOutput(line({ schemaVersion: 1, result: committed, selfWriteEffects: [{ ...effect, fileKey: '../x' }] }))).toThrow()
    expect(decodeCommandOutput(line({ schemaVersion: 1, result: { kind: 'not_found' }, selfWriteEffects: [] }))).toEqual({ result: { kind: 'not_found' }, selfWriteEffects: [] })
  })

  test('refuses every mutation for admissions without the controller writer', async () => {
    expect(await failClosedHostedTaskWriter.mutateWithSelfWriteEffects(request)).toEqual({ result: { kind: 'unavailable' }, selfWriteEffects: [] })
  })
})

describe('retired Owner task WAL', () => {
  test('blocks the start only while a mutation of the old writer is prepared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-task-wal-retired-'))
    roots.push(root)
    await assertNoPreparedRetiredOwnerTaskMutation(root)

    const wal = join(root, 'hosted-task-board-owner-mutation.wal.v1.json')
    await writeFile(wal, JSON.stringify({ schemaVersion: 3, phase: 'terminal', intent: { recordType: 'intent' } }))
    await assertNoPreparedRetiredOwnerTaskMutation(root)

    await writeFile(wal, JSON.stringify({ schemaVersion: 3, phase: 'prepared', intent: { recordType: 'intent' } }))
    await expect(assertNoPreparedRetiredOwnerTaskMutation(root)).rejects.toBeInstanceOf(HostedOwnerTaskWalPreparedError)

    await writeFile(wal, '{')
    await expect(assertNoPreparedRetiredOwnerTaskMutation(root)).rejects.toBeInstanceOf(HostedOwnerTaskWalPreparedError)
  })

  test('checks the legacy WAL name the old Owner writer used too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-task-wal-retired-'))
    roots.push(root)
    await writeFile(join(root, 'hosted-task-board-mutation.wal.v1.json'), JSON.stringify({ phase: 'prepared', intent: { recordType: 'intent' } }))
    await expect(assertNoPreparedRetiredOwnerTaskMutation(root)).rejects.toBeInstanceOf(HostedOwnerTaskWalPreparedError)
  })
})
