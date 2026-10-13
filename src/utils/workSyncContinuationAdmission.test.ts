import { unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { QueryGuard } from './QueryGuard.js'
import {
  applyWorkSyncAdmissionCommand,
  armWorkSyncPostTurnAdmissionWindow,
  bindWorkSyncContinuationAdmission,
  buildWorkSyncAdmissionAckPath,
  buildWorkSyncAdmissionCommandPath,
  buildWorkSyncAdmissionRoot,
  closeLocalWorkSyncAdmissionForUserStop,
  drainWorkSyncAdmissionCommands,
  encodeTeamMemberStorageKey,
  getWorkSyncIdleDeliveryRetryDelayMs,
  isWorkSyncAdmissionHandshakeOpen,
  publishWorkSyncAdmissionFileNoReplace,
  shouldDeferUnticketedWorkSyncNudges,
  resetWorkSyncAdmissionProcessorForTests,
  unbindWorkSyncContinuationAdmission,
  type WorkSyncAdmissionCommand,
} from './workSyncContinuationAdmission.js'

import {
  writeWorkSyncAdmissionCapability,
  type WorkSyncAdmissionCapability,
} from './workSyncAdmissionCapability.js'

const NOW = '2026-09-14T18:00:00.000Z'
const NOW_MS = Date.parse(NOW)

function scope(runtimeInstanceId: string) {
  return {
    teamName: 'team-a',
    teamIncarnation: 'inc-1',
    memberName: 'bob',
    runtimeInstanceId,
  }
}

function reserveCommand(
  guard: QueryGuard,
  overrides: Partial<Extract<WorkSyncAdmissionCommand, { op: 'reserve' }>> = {},
): Extract<WorkSyncAdmissionCommand, { op: 'reserve' }> {
  return {
    schemaVersion: 1,
    requestId: 'req-reserve-1',
    op: 'reserve',
    scope: scope(guard.runtimeInstanceId),
    intentId: 'intent-c1',
    admissionPayloadHash: 'hash-a',
    expectedGeneration: 0,
    reservationNonce: 'nonce-c1',
    controlRevision: 1,
    commandDeadline: '2026-09-14T18:00:30.000Z',
    issuedAt: NOW,
    ...overrides,
  }
}

describe('work-sync continuation admission', () => {
  test.each([1, 2] as const)('attachment readiness version %s is monotonic only within the current runtime instance', async (version) => {
    const teamsDir = await mkdtemp(join(tmpdir(), 'native-capability-instance-'))
    try {
      const capability: WorkSyncAdmissionCapability = {
        schemaVersion: 1, recoveryProtocolVersion: 2, teamName: 'sandbox-team',
        teamIncarnation: 'unspecified', memberName: 'native-member', providerId: 'codex',
        runtimeMode: 'app-server', runtimeInstanceId: 'runtime-a', generation: 0,
        processorReady: true, nativeInboxAttachmentsVersion: version,
        publishedAt: '2026-10-12T00:00:00Z', pid: 101, bootstrapRunId: 'run-a',
      }
      const path = await writeWorkSyncAdmissionCapability(capability, teamsDir)
      const { nativeInboxAttachmentsVersion: _ready, ...notReady } = capability
      await writeWorkSyncAdmissionCapability(notReady, teamsDir)
      expect(JSON.parse(await readFile(path, 'utf8')).nativeInboxAttachmentsVersion).toBe(version)
      await writeWorkSyncAdmissionCapability({ ...notReady, runtimeInstanceId: 'runtime-b', pid: 202, bootstrapRunId: 'run-b' }, teamsDir)
      const updated = { ...notReady, runtimeInstanceId: 'runtime-b', pid: 202, bootstrapRunId: 'run-b', generation: 1 }
      await writeWorkSyncAdmissionCapability(updated, teamsDir)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(updated)
      await Promise.all([
        writeWorkSyncAdmissionCapability({ ...updated, nativeInboxAttachmentsVersion: version }, teamsDir),
        writeWorkSyncAdmissionCapability({ ...updated, generation: 2 }, teamsDir),
      ])
      expect(JSON.parse(await readFile(path, 'utf8')).nativeInboxAttachmentsVersion).toBe(version)
    } finally {
      await rm(teamsDir, { recursive: true, force: true })
    }
  })

  afterEach(() => {
    resetWorkSyncAdmissionProcessorForTests()
    unbindWorkSyncContinuationAdmission()
  })

  test('reserves only after an open control handshake', () => {
    const guard = new QueryGuard('runtime-1')
    const closed = applyWorkSyncAdmissionCommand({
      guard,
      command: reserveCommand(guard),
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(closed.ack).toMatchObject({ ok: false, code: 'stopped' })
    expect(guard.status).toBe('idle')

    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-open',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 1,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    const reserved = applyWorkSyncAdmissionCommand({
      guard,
      command: { ...reserveCommand(guard), requestId: 'req-reserve-2' },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(reserved.ack).toMatchObject({
      ok: true,
      code: 'reserved',
      intentId: 'intent-c1',
      reservationNonce: 'nonce-c1',
    })
    expect(guard.status).toBe('dispatching')
  })

  test('replays the same requestId without changing the first ACK', () => {
    const guard = new QueryGuard('runtime-1')
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-open',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 1,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    const first = applyWorkSyncAdmissionCommand({
      guard,
      command: reserveCommand(guard),
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    const replay = applyWorkSyncAdmissionCommand({
      guard,
      command: {
        ...reserveCommand(guard),
        admissionPayloadHash: 'hash-other',
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(replay.ack).toEqual(first.ack)
  })

  test('cancel before reserve tombstones a later matching reserve', () => {
    const guard = new QueryGuard('runtime-1')
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-open',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 1,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-cancel',
        op: 'cancel',
        scope: scope(guard.runtimeInstanceId),
        intentId: 'intent-c1',
        reservationNonce: 'nonce-c1',
        expectedGeneration: 0,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    const reserved = applyWorkSyncAdmissionCommand({
      guard,
      command: reserveCommand(guard),
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(reserved.ack).toMatchObject({ ok: false, code: 'cancelled' })
    expect(guard.continuationTicket).toBeNull()
  })

  test('reserve with hash then cancel without hash releases the ticket so a late start cannot run', () => {
    const guard = new QueryGuard('runtime-1')
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-open',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 1,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    const reserved = applyWorkSyncAdmissionCommand({
      guard,
      command: reserveCommand(guard),
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(reserved.ack).toMatchObject({ ok: true, code: 'reserved' })
    expect(guard.status).toBe('dispatching')
    const cancelled = applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-cancel-wire',
        op: 'cancel',
        scope: scope(guard.runtimeInstanceId),
        intentId: 'intent-c1',
        reservationNonce: 'nonce-c1',
        expectedGeneration: 0,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(cancelled.ack).toMatchObject({ ok: true, code: 'cancelled' })
    expect(guard.status).toBe('idle')
    expect(guard.continuationTicket).toBeNull()
    expect(
      guard.startReservedContinuation({
        runtimeInstanceId: guard.runtimeInstanceId,
        expectedGeneration: 0,
        reservationNonce: 'nonce-c1',
        intentId: 'intent-c1',
        admissionPayloadHash: 'hash-a',
      }),
    ).toEqual({ ok: false, code: 'stale' })
    expect(guard.status).toBe('idle')
    expect(guard.generation).toBe(0)
  })

  test('rejects expired commands and does not extend TTL on replay', () => {
    const guard = new QueryGuard('runtime-1')
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-open',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 1,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    const expired = applyWorkSyncAdmissionCommand({
      guard,
      command: {
        ...reserveCommand(guard),
        commandDeadline: '2026-09-14T17:59:59.000Z',
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(expired.ack).toMatchObject({ ok: false, code: 'expired' })
  })

  test('stale stop ACK after a newer resume is superseded', () => {
    const guard = new QueryGuard('runtime-1')
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-stop-11',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 11,
        stopped: true,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-resume-12',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 12,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    const lateStop = applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-late-stop-11',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 11,
        stopped: true,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(lateStop.ack).toMatchObject({ ok: false, code: 'superseded' })
    expect(lateStop.control.stopped).toBe(false)
  })

  test('no-replace publish keeps the first bytes on conflict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'work-sync-admission-'))
    try {
      const path = join(dir, 'req.json')
      expect(await publishWorkSyncAdmissionFileNoReplace(path, 'first\n')).toBe(
        'created',
      )
      expect(await publishWorkSyncAdmissionFileNoReplace(path, 'first\n')).toBe(
        'existing-same',
      )
      expect(await publishWorkSyncAdmissionFileNoReplace(path, 'second\n')).toBe(
        'conflict',
      )
      expect(await readFile(path, 'utf8')).toBe('first\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('drain applies cancel before reserve when both files are present', async () => {
    const teamsDir = await mkdtemp(join(tmpdir(), 'work-sync-teams-'))
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = teamsDir
    try {
      const guard = new QueryGuard('runtime-drain')
      bindWorkSyncContinuationAdmission({
        guard,
        teamName: 'team-a',
        memberName: 'bob',
      })
      applyWorkSyncAdmissionCommand({
        guard,
        command: {
          schemaVersion: 1,
          requestId: 'req-open',
          op: 'sync_control',
          scope: scope(guard.runtimeInstanceId),
          controlRevision: 1,
          stopped: false,
          issuedAt: NOW,
        },
        nowIso: NOW,
        nowMs: NOW_MS,
      })
      const root = buildWorkSyncAdmissionRoot({
        teamName: 'team-a',
        memberName: 'bob',
        teamsDir: join(teamsDir, 'teams'),
      })
      expect(encodeTeamMemberStorageKey('Bob')).toBe('bob')
      const reservePath = buildWorkSyncAdmissionCommandPath(
        root,
        guard.runtimeInstanceId,
        'z-reserve',
      )
      const cancelPath = buildWorkSyncAdmissionCommandPath(
        root,
        guard.runtimeInstanceId,
        'a-cancel',
      )
      await publishWorkSyncAdmissionFileNoReplace(
        reservePath,
        `${JSON.stringify(reserveCommand(guard, { requestId: 'z-reserve' }))}\n`,
      )
      await publishWorkSyncAdmissionFileNoReplace(
        cancelPath,
        `${JSON.stringify({
          schemaVersion: 1,
          requestId: 'a-cancel',
          op: 'cancel',
          scope: scope(guard.runtimeInstanceId),
          intentId: 'intent-c1',
          reservationNonce: 'nonce-c1',
          expectedGeneration: 0,
          issuedAt: NOW,
        })}\n`,
      )
      const applied = await drainWorkSyncAdmissionCommands({
        guard,
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: NOW,
        nowMs: NOW_MS,
        teamsDir: join(teamsDir, 'teams'),
      })
      expect(applied).toBe(2)
      expect(guard.continuationTicket).toBeNull()
      const reserveAck = JSON.parse(
        await readFile(
          buildWorkSyncAdmissionAckPath(
            root,
            guard.runtimeInstanceId,
            'z-reserve',
          ),
          'utf8',
        ),
      ) as { code?: string }
      expect(reserveAck.code).toBe('cancelled')
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous
      }
      await rm(teamsDir, { recursive: true, force: true })
    }
  })

  test('rejects a reserve whose incarnation does not match the handshake', () => {
    const guard = new QueryGuard('runtime-1')
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-open',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 1,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    const result = applyWorkSyncAdmissionCommand({
      guard,
      command: reserveCommand(guard, {
        requestId: 'req-wrong-incarnation',
        scope: {
          ...scope(guard.runtimeInstanceId),
          teamIncarnation: 'inc-stale',
        },
      }),
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(result.ack.ok).toBe(false)
    expect(result.ack.code).toBe('instance_mismatch')
    expect(guard.continuationTicket).toBeNull()
  })

  test('unspecified handshake does not bind incarnation; later reserve supplies lifecycle authority', () => {
    const guard = new QueryGuard('runtime-1')
    const opened = applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-open-unspecified',
        op: 'sync_control',
        scope: {
          ...scope(guard.runtimeInstanceId),
          teamIncarnation: 'unspecified',
        },
        controlRevision: 1,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(opened.ack).toMatchObject({ ok: true, code: 'open' })
    expect(opened.control.teamIncarnation).toBeUndefined()

    const reserved = applyWorkSyncAdmissionCommand({
      guard,
      command: reserveCommand(guard, { requestId: 'req-reserve-bound' }),
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(reserved.ack).toMatchObject({ ok: true, code: 'reserved' })
    expect(reserved.control.teamIncarnation).toBe('inc-1')
    expect(guard.continuationTicket?.reservationNonce).toBe('nonce-c1')
  })

  test('retries idle delivery after the post-turn window and while consume-hold is open', () => {
    const now = Date.now()
    armWorkSyncPostTurnAdmissionWindow(now, 1_000)
    expect(getWorkSyncIdleDeliveryRetryDelayMs(now)).toBe(1_000)
    expect(getWorkSyncIdleDeliveryRetryDelayMs(now + 1_000)).toBeNull()

    const holdPath = join(tmpdir(), `work-sync-idle-retry-${now}`)
    const previous = process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH
    writeFileSync(holdPath, 'hold\n')
    process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH = holdPath
    try {
      expect(getWorkSyncIdleDeliveryRetryDelayMs(now + 2_000)).toBe(250)
    } finally {
      unlinkSync(holdPath)
      if (previous === undefined) {
        delete process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH
      } else {
        process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH = previous
      }
    }
  })

  test('rejects a reserve from a stale control revision after resume', () => {
    const guard = new QueryGuard('runtime-1')
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-stop-11',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 11,
        stopped: true,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-resume-12',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 12,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    const reserved = applyWorkSyncAdmissionCommand({
      guard,
      command: reserveCommand(guard, { controlRevision: 10, requestId: 'req-stale-reserve' }),
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(reserved.ack).toMatchObject({ ok: false, code: 'superseded' })
    expect(guard.status).toBe('idle')
  })

  test('expires a reserved continuation at the advertised deadline', () => {
    const guard = new QueryGuard('runtime-1')
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-open',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 1,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    const reserved = applyWorkSyncAdmissionCommand({
      guard,
      command: reserveCommand(guard, {
        commandDeadline: '2026-09-14T18:00:05.000Z',
      }),
      nowIso: NOW,
      nowMs: NOW_MS,
      maxTtlMs: 5_000,
    })
    expect(reserved.ack.ok).toBe(true)
    expect(guard.expireReservedContinuation(NOW_MS + 5_001)).toBe(true)
    expect(guard.status).toBe('idle')
    expect(guard.continuationTicket).toBeNull()
  })

  test('persists an expired continuation even when no command files remain', async () => {
    const teamsDir = await mkdtemp(join(tmpdir(), 'work-sync-expire-'))
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = teamsDir
    try {
      const guard = new QueryGuard('runtime-1')
      applyWorkSyncAdmissionCommand({
        guard,
        command: {
          schemaVersion: 1,
          requestId: 'req-open',
          op: 'sync_control',
          scope: scope(guard.runtimeInstanceId),
          controlRevision: 1,
          stopped: false,
          issuedAt: NOW,
        },
        nowIso: NOW,
        nowMs: NOW_MS,
      })
      applyWorkSyncAdmissionCommand({
        guard,
        command: reserveCommand(guard, {
          commandDeadline: '2026-09-14T18:00:05.000Z',
        }),
        nowIso: NOW,
        nowMs: NOW_MS,
        maxTtlMs: 5_000,
      })
      const root = buildWorkSyncAdmissionRoot({
        teamName: 'team-a',
        memberName: 'bob',
        teamsDir: join(teamsDir, 'teams'),
      })
      await drainWorkSyncAdmissionCommands({
        guard,
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-09-14T18:00:06.000Z',
        nowMs: NOW_MS + 6_000,
        teamsDir: join(teamsDir, 'teams'),
      })
      expect(guard.continuationTicket).toBeNull()
      const snapshot = JSON.parse(
        await readFile(join(root, 'snapshot.json'), 'utf8'),
      ) as { continuation?: unknown; status?: string }
      expect(snapshot.continuation).toBeNull()
      expect(snapshot.status).toBe('idle')
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous
      }
      await rm(teamsDir, { recursive: true, force: true })
    }
  })

  test('local user stop bumps revision so a later open handshake cannot clear it', () => {
    const guard = new QueryGuard('runtime-1')
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-open',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 1,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(isWorkSyncAdmissionHandshakeOpen()).toBe(true)
    closeLocalWorkSyncAdmissionForUserStop(guard)
    const reopened = applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-reopen',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 1,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(reopened.ack).toMatchObject({ ok: false, code: 'superseded' })
    expect(isWorkSyncAdmissionHandshakeOpen()).toBe(false)
    expect(shouldDeferUnticketedWorkSyncNudges()).toBe(true)
  })

  test('keeps deferring unticketed D0 nudges after handshake and user stop', () => {
    const guard = new QueryGuard('runtime-1')
    expect(shouldDeferUnticketedWorkSyncNudges()).toBe(false)
    applyWorkSyncAdmissionCommand({
      guard,
      command: {
        schemaVersion: 1,
        requestId: 'req-open',
        op: 'sync_control',
        scope: scope(guard.runtimeInstanceId),
        controlRevision: 1,
        stopped: false,
        issuedAt: NOW,
      },
      nowIso: NOW,
      nowMs: NOW_MS,
    })
    expect(isWorkSyncAdmissionHandshakeOpen()).toBe(true)
    expect(shouldDeferUnticketedWorkSyncNudges()).toBe(false)
    closeLocalWorkSyncAdmissionForUserStop(guard)
    expect(isWorkSyncAdmissionHandshakeOpen()).toBe(false)
    expect(shouldDeferUnticketedWorkSyncNudges()).toBe(true)
  })
})
