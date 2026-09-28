import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControllerFileLockTimeoutError, withControllerFileLock } from './HostedControllerFileLock.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function ownNamespace(): string | null {
  try { return /^pid:\[([1-9][0-9]*)\]$/.exec(readlinkSync('/proc/self/ns/pid'))?.[1] ?? null } catch { return null }
}

describe('controller-compatible board lock', () => {
  test('writes the controller lock record and releases it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'controller-lock-')); roots.push(root)
    const record = await withControllerFileLock(join(root, 'board-state'), async () => readFile(join(root, 'board-state.lock'), 'utf8'))
    // agent-teams-controller recoverDataLock grammar, with the pidns line where procfs has one.
    const namespace = ownNamespace()
    expect(record).toMatch(new RegExp(`^${process.pid}\\n[0-9]+\\n[0-9a-f-]{36}\\n${namespace === null ? '' : `pidns:${namespace}\\n`}$`))
    expect(await readdir(root)).toEqual([])
  })

  test('reclaims a dead same-namespace owner and never a foreign-namespace one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'controller-lock-')); roots.push(root)
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid
    const namespace = ownNamespace()
    const line = namespace === null ? '' : `pidns:${namespace}\n`
    await writeFile(join(root, 'board-state.lock'), `${exited}\n1\n${'0'.repeat(8)}-0000-0000-0000-000000000000\n${line}`)
    expect(await withControllerFileLock(join(root, 'board-state'), async () => 'entered', { acquireTimeoutMs: 1_000 })).toBe('entered')

    await writeFile(join(root, 'board-state.lock'), `${exited}\n1\n${'0'.repeat(8)}-0000-0000-0000-000000000000\npidns:1\n`)
    if (namespace !== null && namespace !== '1') {
      await expect(withControllerFileLock(join(root, 'board-state'), async () => 'entered', { acquireTimeoutMs: 200 }))
        .rejects.toBeInstanceOf(ControllerFileLockTimeoutError)
    }
  })
})
