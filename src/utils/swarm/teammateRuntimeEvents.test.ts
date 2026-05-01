import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readTeammateRuntimeEvents,
  waitForTeammateRuntimeEvent,
  writeTeammateRuntimeEvent,
} from './teammateRuntimeEvents.js'

const tempDirs = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async dir => {
      await rm(dir, { recursive: true, force: true })
      tempDirs.delete(dir)
    }),
  )
})

async function createRuntimeLogPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'teammate-runtime-events-'))
  tempDirs.add(dir)
  return join(dir, 'alice.runtime.jsonl')
}

describe('teammateRuntimeEvents helpers', () => {
  it('writes and reads runtime events as jsonl', async () => {
    const eventsPath = await createRuntimeLogPath()

    await writeTeammateRuntimeEvent({
      type: 'runtime_ready',
      eventsPath,
      pid: 1234,
      teamName: 'vector-room',
      agentName: 'alice',
      agentId: 'alice@vector-room',
      runId: 'run-1',
      cwd: 'C:\\workspace',
      detail: 'ready',
    })

    const events = await readTeammateRuntimeEvents(eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      version: 1,
      type: 'runtime_ready',
      pid: 1234,
      teamName: 'vector-room',
      agentName: 'alice',
      agentId: 'alice@vector-room',
      runId: 'run-1',
      cwd: 'C:\\workspace',
      detail: 'ready',
    })
  })

  it('waits for a requested event', async () => {
    const eventsPath = await createRuntimeLogPath()

    setTimeout(() => {
      void writeTeammateRuntimeEvent({
        type: 'bootstrap_submitted',
        eventsPath,
        pid: 1234,
      })
    }, 20)

    const result = await waitForTeammateRuntimeEvent({
      eventsPath,
      type: 'bootstrap_submitted',
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      isStillAlive: () => true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.type).toBe('bootstrap_submitted')
    }
  })

  it('returns failure detail while waiting for another event', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'failed',
      eventsPath,
      pid: 1234,
      detail: 'trust not accepted',
    })

    const result = await waitForTeammateRuntimeEvent({
      eventsPath,
      type: 'runtime_ready',
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      isStillAlive: () => true,
    })

    expect(result).toEqual({
      ok: false,
      reason: 'trust not accepted',
    })
  })

  it('ignores stale events from a different pid', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'runtime_ready',
      eventsPath,
      pid: 1111,
    })

    const result = await waitForTeammateRuntimeEvent({
      eventsPath,
      type: 'runtime_ready',
      timeoutMs: 30,
      pollIntervalMs: 10,
      pid: 2222,
      isStillAlive: () => true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('timed out waiting for runtime_ready')
    }
  })
})
