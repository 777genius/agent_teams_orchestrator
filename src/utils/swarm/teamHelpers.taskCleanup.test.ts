import { afterEach, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTaskMutationCoordination } from '../taskMutationCoordinator.js'
import { cleanupTeamDirectories } from './teamHelpers.js'

const roots: string[] = []
const previousConfig = process.env.CLAUDE_CONFIG_DIR

afterEach(async () => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('cleanupTeamDirectories task coordination', () => {
  test('waits for the task-list mutation lane before recursively deleting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-cleanup-test-'))
    roots.push(root)
    process.env.CLAUDE_CONFIG_DIR = root
    const taskPath = join(root, 'tasks', 'test-team', '1.json')
    const teamPath = join(root, 'teams', 'test-team', 'config.json')
    await mkdir(join(root, 'tasks', 'test-team'), { recursive: true })
    await mkdir(join(root, 'teams', 'test-team'), { recursive: true })
    await writeFile(taskPath, '{}')
    await writeFile(teamPath, '{"members":[]}')

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const blocker = withTaskMutationCoordination('test-team', async () => { markStarted(); await gate })
    await started
    const cleanup = cleanupTeamDirectories('test-team')
    await Bun.sleep(0)
    await expect(access(taskPath)).resolves.toBeNull()
    await expect(access(teamPath)).resolves.toBeNull()

    release()
    await Promise.all([blocker, cleanup])
    await expect(access(taskPath)).rejects.toThrow()
    await expect(access(teamPath)).rejects.toThrow()
  })
})
