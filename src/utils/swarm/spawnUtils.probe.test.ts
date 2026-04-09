import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeTmuxTeammateSpawnWithDeps } from './spawnUtils.js'

describe('probeTmuxTeammateSpawnWithDeps', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spawn-probe-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns success as soon as a valid startup-ready sentinel appears', async () => {
    const sentinelPath = join(tempDir, 'startup-ready.json')

    const execFileNoThrowFn: typeof import('../execFileNoThrow.js').execFileNoThrow =
      async (_cmd, args) => {
        if (args.includes('display-message')) {
          return { code: 0, stdout: '0|zsh|123\n', stderr: '' }
        }
        if (args.includes('capture-pane')) {
          return { code: 0, stdout: '', stderr: '' }
        }
        throw new Error(`unexpected args: ${args.join(' ')}`)
      }

    let sleepCount = 0
    const sleepFn: typeof import('../sleep.js').sleep = async () => {
      sleepCount += 1
      if (sleepCount === 1) {
        await writeFile(
          sentinelPath,
          JSON.stringify({
            version: 1,
            kind: 'startup_ready',
            teamName: 'mission-control',
            agentName: 'alice',
            sessionId: 'session-1',
            pid: 123,
            ts: new Date().toISOString(),
          }),
        )
      }
    }

    await expect(
      probeTmuxTeammateSpawnWithDeps(
        '%1',
        {
          readySentinelPath: sentinelPath,
          readyTimeoutMs: 50,
          pollIntervalMs: 1,
        },
        {
          execFileNoThrowFn,
          sleepFn,
        },
      ),
    ).resolves.toBeNull()
  })

  it('keeps the conservative success fallback when the pane is alive but no sentinel arrives', async () => {
    const execFileNoThrowFn: typeof import('../execFileNoThrow.js').execFileNoThrow =
      async (_cmd, args) => {
        if (args.includes('display-message')) {
          return { code: 0, stdout: '0|zsh|456\n', stderr: '' }
        }
        if (args.includes('capture-pane')) {
          return { code: 0, stdout: '', stderr: '' }
        }
        throw new Error(`unexpected args: ${args.join(' ')}`)
      }

    const sleepFn: typeof import('../sleep.js').sleep = async () => {}

    await expect(
      probeTmuxTeammateSpawnWithDeps(
        '%1',
        {
          readySentinelPath: join(tempDir, 'missing.json'),
          readyTimeoutMs: 0,
          pollIntervalMs: 1,
        },
        {
          execFileNoThrowFn,
          sleepFn,
        },
      ),
    ).resolves.toBeNull()
  })
})
