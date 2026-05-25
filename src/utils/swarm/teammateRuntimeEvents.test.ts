import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
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
  mock.restore()
  mock.clearAllMocks()
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

  it('retries a hung runtime event append so readiness markers are not lost', async () => {
    const eventsPath = await createRuntimeLogPath()
    spyOn(fs, 'appendFile').mockImplementationOnce(
      () => new Promise<never>(() => {}) as never,
    )

    const startedAt = Date.now()
    await writeTeammateRuntimeEvent({
      type: 'runtime_ready',
      eventsPath,
      pid: 1234,
      writeAttemptTimeoutMs: 10,
    })
    await writeTeammateRuntimeEvent({
      type: 'inbox_poller_ready',
      eventsPath,
      pid: 1234,
      writeAttemptTimeoutMs: 10,
    })

    expect(Date.now() - startedAt).toBeLessThan(500)
    const events = await readTeammateRuntimeEvents(eventsPath)
    expect(events.map(event => event.type)).toEqual([
      'runtime_ready',
      'inbox_poller_ready',
    ])
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

  it('accepts a fresh identity-matched event when a Windows wrapper pid differs', async () => {
    const eventsPath = await createRuntimeLogPath()
    const sinceMs = Date.now()
    await new Promise(resolve => setTimeout(resolve, 5))
    await writeTeammateRuntimeEvent({
      type: 'runtime_ready',
      eventsPath,
      pid: 3333,
      teamName: 'signal-ops',
      agentName: 'alice',
      agentId: 'alice@signal-ops',
    })

    const result = await waitForTeammateRuntimeEvent({
      eventsPath,
      type: 'runtime_ready',
      timeoutMs: 30,
      pollIntervalMs: 10,
      pid: 2222,
      teamName: 'signal-ops',
      agentName: 'alice',
      agentId: 'alice@signal-ops',
      sinceMs,
      isStillAlive: () => true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.pid).toBe(3333)
    }
  })

  it('ignores stale same-pid readiness events before the launch start time', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'runtime_ready',
      eventsPath,
      pid: 2222,
      teamName: 'signal-ops',
      agentName: 'alice',
      agentId: 'alice@signal-ops',
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    const sinceMs = Date.now()

    const result = await waitForTeammateRuntimeEvent({
      eventsPath,
      type: 'runtime_ready',
      timeoutMs: 30,
      pollIntervalMs: 10,
      pid: 2222,
      teamName: 'signal-ops',
      agentName: 'alice',
      agentId: 'alice@signal-ops',
      sinceMs,
      isStillAlive: () => true,
    })

    expect(result.ok).toBe(false)
  })

  it('does not accept pid-mismatched readiness without explicit teammate identity', async () => {
    const eventsPath = await createRuntimeLogPath()
    const sinceMs = Date.now()
    await new Promise(resolve => setTimeout(resolve, 5))
    await writeTeammateRuntimeEvent({
      type: 'runtime_ready',
      eventsPath,
      pid: 3333,
    })

    const result = await waitForTeammateRuntimeEvent({
      eventsPath,
      type: 'runtime_ready',
      timeoutMs: 30,
      pollIntervalMs: 10,
      pid: 2222,
      teamName: 'signal-ops',
      agentName: 'alice',
      agentId: 'alice@signal-ops',
      sinceMs,
      isStillAlive: () => true,
    })

    expect(result.ok).toBe(false)
  })

  it('reports the last matching runtime stage when a requested event times out', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'runtime_ready',
      eventsPath,
      pid: 1234,
      detail: 'inbox poller mounted',
    })
    await writeTeammateRuntimeEvent({
      type: 'mailbox_bootstrap_written',
      eventsPath,
      pid: 1234,
      detail: 'messageId=bootstrap-alice-1',
    })

    const result = await waitForTeammateRuntimeEvent({
      eventsPath,
      type: 'inbox_poller_ready',
      timeoutMs: 30,
      pollIntervalMs: 10,
      pid: 1234,
      isStillAlive: () => true,
    })

    expect(result).toEqual({
      ok: false,
      reason:
        'timed out waiting for inbox_poller_ready; last runtime stage: mailbox_bootstrap_written: messageId=bootstrap-alice-1',
    })
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

    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submit_rejected',
      eventsPath,
      pid: 1234,
      retryable: true,
      detail: 'submit rejected by local prompt handler',
    })
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

  it('accepts identity-matched bootstrap submission when a Windows wrapper pid differs', async () => {
    const eventsPath = await createRuntimeLogPath()
    const sinceMs = Date.now()
    await new Promise(resolve => setTimeout(resolve, 5))
    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submitted',
      eventsPath,
      pid: 3333,
      teamName: 'signal-ops',
      agentName: 'atlas',
      agentId: 'atlas@signal-ops',
      bootstrapRunId: 'run-atlas-1',
      bootstrapMirrorId: 'bootstrap-atlas-1',
    })

    const result = await waitForBootstrapSubmissionOutcome({
      eventsPath,
      timeoutMs: 30,
      pollIntervalMs: 10,
      pid: 2222,
      teamName: 'signal-ops',
      agentName: 'atlas',
      agentId: 'atlas@signal-ops',
      bootstrapRunId: 'run-atlas-1',
      bootstrapMirrorId: 'bootstrap-atlas-1',
      sinceMs,
      isStillAlive: () => true,
    })

    expect(result.type).toBe('submitted')
    if (result.type === 'submitted') {
      expect(result.event.pid).toBe(3333)
    }
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

  it('ignores stale submitted and failed events before the launch start time', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submitted',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-4',
      detail: 'old submit from previous launch',
    })
    await writeTeammateRuntimeEvent({
      type: 'failed',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      detail: 'old runtime failure from previous launch',
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    const sinceMs = Date.now()
    await new Promise(resolve => setTimeout(resolve, 5))
    await writeTeammateRuntimeEvent({
      type: 'mailbox_bootstrap_written',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-4',
      detail: 'messageId=bootstrap-atlas-4',
    })

    const result = await waitForBootstrapSubmissionOutcome({
      eventsPath,
      timeoutMs: 30,
      pollIntervalMs: 10,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapMirrorId: 'bootstrap-atlas-4',
      sinceMs,
      isStillAlive: () => true,
    })

    expect(result.type).toBe('timeout')
    if (result.type === 'timeout') {
      expect(result.lastStage?.type).toBe('mailbox_bootstrap_written')
      expect(result.reason).toContain(
        'last transport stage: mailbox_bootstrap_written: messageId=bootstrap-atlas-4',
      )
    }
  })

  it('ignores same-mirror submit proof from a different bootstrap run', async () => {
    const eventsPath = await createRuntimeLogPath()
    await writeTeammateRuntimeEvent({
      type: 'mailbox_bootstrap_written',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapRunId: 'run-new',
      bootstrapMirrorId: 'bootstrap-atlas-5',
      detail: 'messageId=bootstrap-atlas-5',
    })
    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submitted',
      eventsPath,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapRunId: 'run-old',
      bootstrapMirrorId: 'bootstrap-atlas-5',
      detail: 'submit proof from previous launch run',
    })

    const result = await waitForBootstrapSubmissionOutcome({
      eventsPath,
      timeoutMs: 30,
      pollIntervalMs: 10,
      pid: 1234,
      teamName: 'signal-ops',
      agentName: 'atlas',
      bootstrapRunId: 'run-new',
      bootstrapMirrorId: 'bootstrap-atlas-5',
      isStillAlive: () => true,
    })

    expect(result.type).toBe('timeout')
    if (result.type === 'timeout') {
      expect(result.lastStage?.type).toBe('mailbox_bootstrap_written')
      expect(result.reason).toContain(
        'last transport stage: mailbox_bootstrap_written: messageId=bootstrap-atlas-5',
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
