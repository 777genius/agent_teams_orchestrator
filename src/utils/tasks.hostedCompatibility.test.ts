import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgentStatuses, getTask, listTasks, unassignTeammateTasks } from './tasks.js'

let root = ''
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tasks-hosted-compatibility-'))
  process.env.CLAUDE_CONFIG_DIR = root
})

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

describe('hosted task file compatibility', () => {
  test('get and list normalize an omitted description without rewriting the hosted postimage', async () => {
    const taskListId = 'hosted-compatible-team'; const taskId = `task_${'a'.repeat(32)}`
    const directory = join(root, 'tasks', taskListId); await mkdir(directory, { recursive: true })
    const path = join(directory, `${taskId}.json`)
    const contents = `${JSON.stringify({ id: taskId, subject: 'Hosted task', status: 'pending', blocks: [], blockedBy: [] }, null, 2)}\n`
    await writeFile(path, contents)

    expect(await getTask(taskListId, taskId)).toEqual({ id: taskId, subject: 'Hosted task', description: '', status: 'pending', blocks: [], blockedBy: [] })
    expect(await listTasks(taskListId)).toEqual([{ id: taskId, subject: 'Hosted task', description: '', status: 'pending', blocks: [], blockedBy: [] }])
    expect(await readFile(path, 'utf8')).toBe(contents)
  })

  test('still rejects present non-string descriptions and missing required task fields', async () => {
    const taskListId = 'hosted-invalid-team'; const directory = join(root, 'tasks', taskListId); await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'bad-description.json'), JSON.stringify({ id: 'bad-description', subject: 'Bad', description: null, status: 'pending', blocks: [], blockedBy: [] }))
    await writeFile(join(directory, 'missing-required.json'), JSON.stringify({ id: 'missing-required', subject: 'Bad', status: 'pending', blocks: [] }))
    expect(await getTask(taskListId, 'bad-description')).toBeNull()
    expect(await getTask(taskListId, 'missing-required')).toBeNull()
    expect(await listTasks(taskListId)).toEqual([])
  })

  test('keeps opaque hosted owners unless an exact immutable roster identity is available', async () => {
    const taskListId = 'hosted-owner-team'; const teamId = `team_${'7'.repeat(32)}`; const agentId = 'agent-worker'; const name = 'worker'
    const owner = `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: agentId })).digest('hex').slice(0, 32)}`
    const tasksDirectory = join(root, 'tasks', taskListId); const teamDirectory = join(root, 'teams', taskListId)
    await mkdir(tasksDirectory, { recursive: true }); await mkdir(teamDirectory, { recursive: true })
    await writeFile(join(teamDirectory, 'config.json'), JSON.stringify({ leadAgentId: 'lead', members: [{ agentId, name }] }))
    const taskPath = join(tasksDirectory, 'owned.json')
    await writeFile(taskPath, JSON.stringify({ id: 'owned', subject: 'Owned', description: '', owner, status: 'pending', blocks: [], blockedBy: [] }))

    expect((await unassignTeammateTasks(taskListId, agentId, name, 'shutdown')).unassignedTasks).toEqual([])
    expect((await getTask(taskListId, 'owned'))?.owner).toBe(owner)

    await writeFile(join(teamDirectory, 'team.identity.json'), JSON.stringify({ schemaVersion: 1, teamId, createdAt: '2026-01-01T00:00:00.000Z' }))
    await writeFile(join(teamDirectory, 'members.meta.json'), '{malformed')
    expect((await unassignTeammateTasks(taskListId, agentId, name, 'shutdown')).unassignedTasks).toEqual([])
    expect((await getTask(taskListId, 'owned'))?.owner).toBe(owner)
    await writeFile(join(teamDirectory, 'members.meta.json'), `${JSON.stringify({ version: 1, members: [{ name, agentId }] })}${' '.repeat(256 * 1024)}`)
    expect((await unassignTeammateTasks(taskListId, agentId, name, 'shutdown')).unassignedTasks).toEqual([])
    expect((await getTask(taskListId, 'owned'))?.owner).toBe(owner)
    await rm(join(teamDirectory, 'members.meta.json'))
    expect(await getAgentStatuses(taskListId)).toEqual([{ agentId, name, agentType: undefined, status: 'busy', currentTasks: ['owned'] }])
    expect((await unassignTeammateTasks(taskListId, agentId, name, 'shutdown')).unassignedTasks).toEqual([{ id: 'owned', subject: 'Owned' }])
    expect((await getTask(taskListId, 'owned'))?.owner).toBeUndefined()
  })

  test('joins a unique active memberId-only roster row to the legacy config agent identity', async () => {
    const taskListId = 'hosted-member-id-parity'; const teamId = `team_${'8'.repeat(32)}`; const agentId = 'worker@hosted-member-id-parity'; const name = 'worker'; const memberId = `member_${'a'.repeat(32)}`
    const tasksDirectory = join(root, 'tasks', taskListId); const teamDirectory = join(root, 'teams', taskListId)
    await mkdir(tasksDirectory, { recursive: true }); await mkdir(teamDirectory, { recursive: true })
    await writeFile(join(teamDirectory, 'config.json'), JSON.stringify({ leadAgentId: 'lead', members: [{ agentId, name, agentType: 'general-purpose' }] }))
    await writeFile(join(teamDirectory, 'team.identity.json'), JSON.stringify({ schemaVersion: 1, teamId, createdAt: '2026-01-01T00:00:00.000Z' }))
    await writeFile(join(teamDirectory, 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name, memberId }] }))
    await writeFile(join(tasksDirectory, 'owned.json'), JSON.stringify({ id: 'owned', subject: 'Owned', description: '', owner: memberId, status: 'pending', blocks: [], blockedBy: [] }))

    expect(await getAgentStatuses(taskListId)).toEqual([{ agentId, name, agentType: 'general-purpose', status: 'busy', currentTasks: ['owned'] }])
    expect((await unassignTeammateTasks(taskListId, agentId, name, 'shutdown')).unassignedTasks).toEqual([{ id: 'owned', subject: 'Owned' }])
    expect((await getTask(taskListId, 'owned'))?.owner).toBeUndefined()
  })

  test('uses only the active same-name replacement and fails closed for duplicate active roster rows', async () => {
    const taskListId = 'hosted-roster-replacement'; const agentId = 'worker@hosted-roster-replacement'; const name = 'worker'; const removedId = `member_${'b'.repeat(32)}`; const activeId = `member_${'c'.repeat(32)}`
    const tasksDirectory = join(root, 'tasks', taskListId); const teamDirectory = join(root, 'teams', taskListId)
    await mkdir(tasksDirectory, { recursive: true }); await mkdir(teamDirectory, { recursive: true })
    await writeFile(join(teamDirectory, 'config.json'), JSON.stringify({ leadAgentId: 'lead', members: [{ agentId, name }] }))
    await writeFile(join(teamDirectory, 'team.identity.json'), JSON.stringify({ schemaVersion: 1, teamId: `team_${'9'.repeat(32)}`, createdAt: '2026-01-01T00:00:00.000Z' }))
    await writeFile(join(teamDirectory, 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name, memberId: removedId, joinedAt: 1, removedAt: 2 }, { name, memberId: activeId, joinedAt: 2 }] }))
    await writeFile(join(tasksDirectory, 'removed.json'), JSON.stringify({ id: 'removed', subject: 'Removed', description: '', owner: removedId, status: 'pending', blocks: [], blockedBy: [] }))
    await writeFile(join(tasksDirectory, 'active.json'), JSON.stringify({ id: 'active', subject: 'Active', description: '', owner: activeId, status: 'pending', blocks: [], blockedBy: [] }))

    expect((await unassignTeammateTasks(taskListId, agentId, name, 'shutdown')).unassignedTasks).toEqual([{ id: 'active', subject: 'Active' }])
    expect((await getTask(taskListId, 'removed'))?.owner).toBe(removedId)

    await writeFile(join(teamDirectory, 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name, memberId: removedId }, { name: name.toUpperCase(), memberId: activeId }] }))
    expect((await unassignTeammateTasks(taskListId, agentId, name, 'shutdown')).unassignedTasks).toEqual([])
    expect((await getTask(taskListId, 'removed'))?.owner).toBe(removedId)
  })
})
