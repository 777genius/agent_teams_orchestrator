import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readTeammateRuntimeEvents,
  waitForBootstrapSubmissionOutcome,
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

  it('does not extend bootstrap submission timeout without retryable rejection', async () => {
    const eventsPath = await createRuntimeLogPath()
    const startedAt = Date.now()

    const result = await waitForBootstrapSubmissionOutcome({
      eventsPath,
      timeoutMs: 30,
      retryableSubmitGraceMs: 200,
      pollIntervalMs: 10,
      pid: 1234,
      isStillAlive: () => true,
    })

    expect(result.type).toBe('timeout')
    expect(Date.now() - startedAt).toBeLessThan(150)
  })

  it('extends bootstrap submission wait for fresh retryable submit rejection', async () => {
    const eventsPath = await createRuntimeLogPath()

    setTimeout(() => {
      void writeTeammateRuntimeEvent({
        type: 'bootstrap_submit_rejected',
        eventsPath,
        pid: 1234,
        retryable: true,
        detail: 'submit rejected by local prompt handler',
      })
    }, 5)
    setTimeout(() => {
      void writeTeammateRuntimeEvent({
        type: 'bootstrap_submitted',
        eventsPath,
        pid: 1234,
      })
    }, 60)

    const result = await waitForBootstrapSubmissionOutcome({
      eventsPath,
      timeoutMs: 20,
      retryableSubmitGraceMs: 200,
      retryableSubmitFreshMs: 100,
      pollIntervalMs: 10,
      pid: 1234,
      isStillAlive: () => true,
    })

    expect(result.type).toBe('submitted')
  })

  it('ignores bootstrap_submitted events without the expected mirror id', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submitted',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
    })

    const result = await waitForBootstrapSubmissionOutcome({
      eventsPath,
      timeoutMs: 30,
      pollIntervalMs: 10,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-1',
      isStillAlive: () => true,
    })

    expect(result.type).toBe('timeout')
  })

  it('reports the verified mailbox write as last stage when stale submit proof has the wrong mirror id', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'inbox_poller_ready',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      detail: 'initial poll observed bootstrap prompt',
    })
    await writeTeammateRuntimeEvent({
      type: 'mailbox_bootstrap_written',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-1',
      detail: 'messageId=bootstrap-atlas-1',
    })
    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submitted',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'stale-bootstrap-atlas-0',
      detail: 'messageId=stale-bootstrap-atlas-0',
    })

    const result = await waitForBootstrapSubmissionOutcome({
      eventsPath,
      timeoutMs: 30,
      pollIntervalMs: 10,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-1',
      isStillAlive: () => true,
    })

    expect(result.type).toBe('timeout')
    if (result.type === 'timeout') {
      expect(result.lastStage?.type).toBe('mailbox_bootstrap_written')
      expect(result.reason).toContain(
        'last transport stage: mailbox_bootstrap_written: messageId=bootstrap-atlas-1',
      )
    }
  })

  it('uses same-mirror submit attempt as timeout stage while ignoring wrong-mirror submit success', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'mailbox_bootstrap_written',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-2',
      detail: 'messageId=bootstrap-atlas-2',
    })
    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submit_attempted',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-2',
      detail: 'submitting bootstrap prompt',
    })
    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submitted',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-other',
      detail: 'messageId=bootstrap-other',
    })

    const result = await waitForBootstrapSubmissionOutcome({
      eventsPath,
      timeoutMs: 30,
      pollIntervalMs: 10,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-2',
      isStillAlive: () => true,
    })

    expect(result.type).toBe('timeout')
    if (result.type === 'timeout') {
      expect(result.lastStage?.type).toBe('bootstrap_submit_attempted')
      expect(result.reason).toContain('last transport stage: bootstrap_submit_attempted')
    }
  })

  it('returns terminal failure with last relevant stage when process exits after submit attempt', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'mailbox_bootstrap_written',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-3',
      detail: 'messageId=bootstrap-atlas-3',
    })
    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submit_attempted',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-3',
      detail: 'submitting bootstrap prompt',
    })
    let aliveChecks = 0

    const result = await waitForBootstrapSubmissionOutcome({
      eventsPath,
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-3',
      isStillAlive: () => {
        aliveChecks += 1
        return aliveChecks === 1
      },
    })

    expect(result).toMatchObject({
      type: 'terminal_failure',
      reason: 'teammate process exited before bootstrap_submitted',
      event: {
        type: 'bootstrap_submit_attempted',
        bootstrapMirrorId: 'bootstrap-atlas-3',
      },
    })
  })

  it('does not extend indefinitely for stale retryable submit rejection', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submit_rejected',
      eventsPath,
      pid: 1234,
      retryable: true,
      detail: 'old submit rejection',
    })
    await new Promise(resolve => setTimeout(resolve, 30))

    const startedAt = Date.now()
    const result = await waitForBootstrapSubmissionOutcome({
      eventsPath,
      timeoutMs: 10,
      retryableSubmitGraceMs: 200,
      retryableSubmitFreshMs: 5,
      pollIntervalMs: 10,
      pid: 1234,
      isStillAlive: () => true,
    })

    expect(result.type).toBe('timeout')
    expect(Date.now() - startedAt).toBeLessThan(150)
  })

  it('keeps fatal submit rejection terminal before bootstrap submission', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submit_rejected',
      eventsPath,
      pid: 1234,
      retryable: false,
      detail: 'fatal submit rejection',
    })

    const result = await waitForBootstrapSubmissionOutcome({
      eventsPath,
      timeoutMs: 1_000,
      retryableSubmitGraceMs: 1_000,
      pollIntervalMs: 10,
      pid: 1234,
      isStillAlive: () => true,
    })

    expect(result).toMatchObject({
      type: 'terminal_failure',
      reason: 'fatal submit rejection',
    })
  })
})
