import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostedControllerTaskWriter } from './HostedControllerTaskWriter.js'
import {
  fingerprintHostedTaskCommand,
  type HostedControlStableAuthority,
  type HostedTaskMutationCommand,
  type HostedTaskMutationRequest,
  type HostedTaskMutationTerminalResult,
} from './protocol.js'

/**
 * Runs the Owner writer against a real Product MCP bundle: set HOSTED_TASK_COMMAND_BUNDLE to its
 * `dist/index.js` (and HOSTED_TASK_COMMAND_NODE to the node binary, default `node`). Skipped
 * otherwise, since the bundle is built in the Product repository.
 */
const BUNDLE = process.env.HOSTED_TASK_COMMAND_BUNDLE
const NODE = process.env.HOSTED_TASK_COMMAND_NODE ?? 'node'
const TEAM = 'bundle-team'
const WORKER_ID = `member_${'b1'.repeat(16)}`

const authority: HostedControlStableAuthority = {
  deploymentId: 'deployment_bundle',
  bootId: 'boot_bundle',
  restoreGeneration: 1,
  workspaceId: 'workspace_bundle',
  mountBinding: { mountGeneration: 1, declaredRootHash: 'a'.repeat(64) },
  teamId: `team_${'c'.repeat(32)}`,
}

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function board() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-task-bundle-')))
  roots.push(root)
  const teamDir = join(root, 'teams', TEAM)
  await mkdir(teamDir, { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'tasks', TEAM), { recursive: true, mode: 0o700 })
  const members = [
    { name: 'team-lead', agentId: `team-lead@${TEAM}`, agentType: 'team-lead' },
    { name: 'worker', memberId: WORKER_ID, agentId: `worker@${TEAM}`, agentType: 'general-purpose' },
  ]
  await writeFile(join(teamDir, 'config.json'), `${JSON.stringify({ name: TEAM, members }, null, 2)}\n`)
  await writeFile(join(teamDir, 'members.meta.json'), `${JSON.stringify({ version: 1, members }, null, 2)}\n`)
  const writer = new HostedControllerTaskWriter({
    command: NODE,
    entry: BUNDLE!,
    claudeRoot: root,
    legacyKey: TEAM,
    authority,
    isCurrent: () => true,
    answerDeadlineMs: 15_000,
  })
  let sequence = 0
  let generation = 'generation_unknown'
  let revision = 'revision_unknown'
  /** Retries once on a stale generation or revision, as the browser does after reloading the board. */
  const mutate = async (body: Record<string, unknown>) => {
    let result: HostedTaskMutationTerminalResult | undefined
    let outcome
    let sent: HostedTaskMutationCommand | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      sequence += 1
      const command = {
        schemaVersion: 1,
        commandId: `command_bundle-${sequence}`,
        idempotencyKey: `bundle:${sequence}`,
        teamId: authority.teamId,
        expectedSourceGeneration: generation,
        expectedRevision: revision,
        ...body,
      } as HostedTaskMutationCommand
      sent = command
      outcome = await writer.mutateWithSelfWriteEffects(request(command))
      result = outcome.result
      if (result.kind === 'stale_generation') { generation = result.currentSourceGeneration; continue }
      if (result.kind === 'stale_revision') { revision = result.currentRevision; continue }
      break
    }
    if (result?.kind === 'committed' || result?.kind === 'idempotent_replay') revision = result.receipt.revision
    return { outcome: outcome!, command: sent! }
  }
  const readTask = async (rawId: string) =>
    JSON.parse(await readFile(join(root, 'tasks', TEAM, `${rawId}.json`), 'utf8')) as Record<string, unknown>
  const taskFiles = async () => (await readdir(join(root, 'tasks', TEAM))).filter(name => name.endsWith('.json'))
  return { root, writer, mutate, readTask, taskFiles }
}

function request(command: HostedTaskMutationCommand): HostedTaskMutationRequest {
  return {
    schemaVersion: 2,
    exchangeId: `task-request_${'2'.repeat(32)}`,
    operation: 'task_mutate',
    ownerBinding: {
      ownerAuthority: 'owner-authority_bundle',
      ownerGeneration: 1,
      ownerSessionId: 'owner-session_bundle',
      socketIdentity: { device: '1', inode: '2', uid: 501, gid: 20, mode: 0o600 },
    },
    authority: { actorId: 'actor_bundle', ...authority },
    payload: { command, payloadFingerprint: fingerprintHostedTaskCommand(command) },
    ownerProof: '',
  }
}

describe.skipIf(!BUNDLE)('HostedControllerTaskWriter against the Product MCP bundle', () => {
  test('creates, replays and moves a task through the controller like desktop', async () => {
    const { writer, mutate, readTask, taskFiles } = await board()

    const created = await mutate({ kind: 'create_task', subject: 'Bundle task', description: null, status: 'pending', ownerId: WORKER_ID, column: 'todo', order: 0 })
    expect(created.outcome.result.kind).toBe('committed')
    const [file] = await taskFiles()
    expect(file).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/)
    const rawId = file!.slice(0, -'.json'.length)
    expect(created.outcome.selfWriteEffects.map(effect => effect.fileKey)).toContain(rawId)
    expect(await readTask(rawId)).toMatchObject({ id: rawId, subject: 'Bundle task', status: 'pending', owner: 'worker' })
    if (created.outcome.result.kind !== 'committed') throw new Error('unreachable')
    const taskId = created.outcome.result.receipt.affectedTaskIds[0]!

    // The same create command replays instead of writing a second task.
    const replay = await writer.mutateWithSelfWriteEffects(request(created.command))
    expect(replay.result.kind).toBe('idempotent_replay')
    expect(replay.selfWriteEffects).toEqual([])
    expect(await taskFiles()).toHaveLength(1)

    const started = await mutate({ kind: 'move_task', taskId, column: 'in_progress', order: 0 })
    expect(started.outcome.result.kind).toBe('committed')
    expect((await readTask(rawId)).status).toBe('in_progress')

    const done = await mutate({ kind: 'move_task', taskId, column: 'done', order: 0 })
    expect(done.outcome.result.kind).toBe('committed')
    expect((await readTask(rawId)).status).toBe('completed')
  }, 60_000)
})
