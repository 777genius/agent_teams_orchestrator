import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isTaskMutationCoordinated,
  withTaskMutationCoordination,
} from './taskMutationCoordinator.js'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'task-coordinator-test-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('taskMutationCoordinator', () => {
  test('serializes mutations for one team', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })

    const first = withTaskMutationCoordination('team-a', async () => {
      events.push('first-start')
      await gate
      events.push('first-end')
    }, { claudeRoot: root })
    const second = withTaskMutationCoordination('team-a', async () => {
      events.push('second')
    }, { claudeRoot: root })

    for (let attempt = 0; attempt < 50 && events.length === 0; attempt += 1) await Bun.sleep(2)
    expect(events).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first-start', 'first-end', 'second'])
  })

  test('allows nested mutations for the same team without deadlock', async () => {
    await withTaskMutationCoordination('team-reentrant', async () => {
      expect(isTaskMutationCoordinated('team-reentrant')).toBe(true)
      await withTaskMutationCoordination('team-reentrant', async () => {
        expect(isTaskMutationCoordinated('team-reentrant')).toBe(true)
      })
    }, { claudeRoot: root })
  })

  test('does not serialize independent teams', async () => {
    let teamBStarted = false
    let releaseA!: () => void
    const gate = new Promise<void>(resolve => {
      releaseA = resolve
    })
    const teamA = withTaskMutationCoordination('team-independent-a', () => gate, { claudeRoot: root })
    const teamB = withTaskMutationCoordination('team-independent-b', async () => {
      teamBStarted = true
    }, { claudeRoot: root })

    await teamB
    expect(teamBStarted).toBe(true)
    releaseA()
    await teamA
  })

  test('serializes the same task list across dedicated processes', async () => {
    const output = join(root, 'events.txt')
    const script = (label: string) => `
      import { appendFile } from 'node:fs/promises';
      import { withTaskMutationCoordination } from './src/utils/taskMutationCoordinator.ts';
      await withTaskMutationCoordination('shared-team', async () => {
        await appendFile(${JSON.stringify(output)}, ${JSON.stringify(`${label}-start\n`)});
        await Bun.sleep(75);
        await appendFile(${JSON.stringify(output)}, ${JSON.stringify(`${label}-end\n`)});
      }, { claudeRoot: ${JSON.stringify(root)} });
    `
    const first = Bun.spawn([process.execPath, '-e', script('a')], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
    const second = Bun.spawn([process.execPath, '-e', script('b')], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
    expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0])
    const events = (await readFile(output, 'utf8')).trim().split('\n')
    expect(JSON.stringify(events) === JSON.stringify(['a-start', 'a-end', 'b-start', 'b-end']) || JSON.stringify(events) === JSON.stringify(['b-start', 'b-end', 'a-start', 'a-end'])).toBe(true)
  })

  test('fails closed on a preplanted symlink lock anchor', async () => {
    const lockRoot = join(root, 'tasks', '.mutation-locks'); await mkdir(lockRoot, { recursive: true, mode: 0o700 })
    const outside = join(root, 'outside'); await writeFile(outside, 'do-not-lock')
    await symlink(outside, join(lockRoot, 'symlink-team.lock'))
    await expect(withTaskMutationCoordination('symlink-team', async () => {}, { claudeRoot: root })).rejects.toThrow()
    expect(await readFile(outside, 'utf8')).toBe('do-not-lock')
  })

  test('releases the proper lock after detecting anchor substitution', async () => {
    const lockPath = join(root, 'tasks', '.mutation-locks', 'replace-team.lock')
    await expect(withTaskMutationCoordination('replace-team', async () => { await rm(lockPath); await writeFile(lockPath, 'replacement', { mode: 0o600 }) }, { claudeRoot: root })).rejects.toThrow('changed while held')
    await expect(withTaskMutationCoordination('replace-team', async () => 'next', { claudeRoot: root })).resolves.toBe('next')
  })
})
