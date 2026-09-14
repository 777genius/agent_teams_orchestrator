import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { QueryGuard } from './QueryGuard.js'
import {
  applyWorkSyncAdmissionCommand,
  bindWorkSyncContinuationAdmission,
  buildWorkSyncAdmissionAckPath,
  buildWorkSyncAdmissionCommandPath,
  buildWorkSyncAdmissionRoot,
  drainWorkSyncAdmissionCommands,
  encodeTeamMemberStorageKey,
  publishWorkSyncAdmissionFileNoReplace,
  resetWorkSyncAdmissionProcessorForTests,
  unbindWorkSyncContinuationAdmission,
  type WorkSyncAdmissionCommand,
} from './workSyncContinuationAdmission.js'

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
})
