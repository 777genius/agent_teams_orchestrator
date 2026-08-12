import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fsPromises = await import('node:fs/promises')
const actualReadFile = fsPromises.readFile

let watchedTaskPath: string | undefined
let releaseSnapshot: (() => void) | undefined
let snapshotCaptured: Promise<void> | undefined
let markSnapshotCaptured: (() => void) | undefined

mock.module('node:fs/promises', () => ({
  ...fsPromises,
  readFile: async (...args: Parameters<typeof actualReadFile>) => {
    const result = await actualReadFile(...args)
    if (String(args[0]) === watchedTaskPath && markSnapshotCaptured) {
      const markCaptured = markSnapshotCaptured
      markSnapshotCaptured = undefined
      markCaptured()
      await new Promise<void>(resolve => {
        releaseSnapshot = resolve
      })
    }
    return result
  },
}))

const { createTask, getTask, unassignTeammateTasks, updateTask } = await import(
  './tasks.js'
)
const { withTaskMutationCoordination } = await import(
  './taskMutationCoordinator.js'
)

let root = ''
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tasks-coordination-test-'))
  process.env.CLAUDE_CONFIG_DIR = root
})

afterAll(async () => {
  releaseSnapshot?.()
  mock.restore()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

describe('unassignTeammateTasks coordination', () => {
  test('does not clear an owner assigned after cleanup was requested', async () => {
    const teamName = 'coordination-regression-team'
    const taskId = await createTask(teamName, {
      subject: 'Keep the current owner',
      description: 'Regression fixture',
      status: 'in_progress',
      owner: 'departing-agent',
      blocks: [],
      blockedBy: [],
    })
    watchedTaskPath = join(root, 'tasks', teamName, `${taskId}.json`)
    snapshotCaptured = new Promise<void>(resolve => {
      markSnapshotCaptured = resolve
    })

    const cleanup = unassignTeammateTasks(
      teamName,
      'departing-agent',
      'Departing Agent',
      'shutdown',
    )
    await snapshotCaptured

    let reassignmentEntered = false
    const reassignment = withTaskMutationCoordination(teamName, async () => {
      reassignmentEntered = true
      await updateTask(teamName, taskId, {
        owner: 'replacement-agent',
        status: 'in_progress',
      })
    })

    await Promise.resolve()
    expect(reassignmentEntered).toBe(false)
    releaseSnapshot?.()

    const result = await cleanup
    await reassignment

    expect(result.unassignedTasks).toEqual([
      { id: taskId, subject: 'Keep the current owner' },
    ])
    expect((await getTask(teamName, taskId))?.owner).toBe('replacement-agent')
  })
})
