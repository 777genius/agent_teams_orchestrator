import { describe, expect, test } from 'bun:test'
import {
  attemptProcessCleanupOnce,
  canProveSpawnedChildExited,
  canReplaceProcessSpawnReservation,
  isUnpublishedProcessRecoveryBlocker,
  shouldRetainProcessRecoveryBlocker,
} from './processSpawnRecovery.js'

describe('process spawn recovery', () => {
  test.each(['spawn probe failure', 'runtime-ready failure'])(
    '%s retains identity and blocks duplicate spawn after failed cleanup',
    failure => {
      expect(failure).toBeTruthy()
      expect(shouldRetainProcessRecoveryBlocker({ childWasSpawned: true, cleanupConfirmed: false })).toBe(true)
      expect(isUnpublishedProcessRecoveryBlocker({ processOwnerToken: 'owner', processRunId: 'run' }, null)).toBe(true)
    },
  )

  test('start-time capture failure sends no PID signal and retains blocker while exit is unconfirmed', () => {
    const cleanupConfirmed = canProveSpawnedChildExited({ exitCode: null, signalCode: null })
    expect(cleanupConfirmed).toBe(false)
    expect(shouldRetainProcessRecoveryBlocker({ childWasSpawned: true, cleanupConfirmed })).toBe(true)
  })

  test('atomic reservation blocks pending/live owners and only replaces a proven-dead pid', () => {
    expect(canReplaceProcessSpawnReservation({ existingOwnerToken: 'old', nextOwnerToken: 'new', existingPid: null, existingPidAlive: false })).toBe(false)
    expect(canReplaceProcessSpawnReservation({ existingOwnerToken: 'old', nextOwnerToken: 'new', existingPid: 42, existingPidAlive: true })).toBe(false)
    expect(canReplaceProcessSpawnReservation({ existingOwnerToken: 'old', nextOwnerToken: 'new', existingPid: 42, existingPidAlive: false })).toBe(true)
  })

  test.each(['inbox-poller readiness failure', 'bootstrap submission failure'])(
    '%s keeps the first successful exact cleanup and creates no false recovery',
    async failure => {
      expect(failure).toBeTruthy()
      const state = { attempted: false, confirmed: false }
      let cleanupCalls = 0
      let recoveries = 0
      const exactCleanup = async () => {
        cleanupCalls += 1
        return true
      }

      await expect(attemptProcessCleanupOnce(state, exactCleanup)).resolves.toBe(true)
      await expect(attemptProcessCleanupOnce(state, exactCleanup)).resolves.toBe(true)
      if (shouldRetainProcessRecoveryBlocker({
        childWasSpawned: true,
        cleanupConfirmed: state.confirmed,
      })) {
        recoveries += 1
      }

      expect(state).toEqual({ attempted: true, confirmed: true })
      expect(cleanupCalls).toBe(1)
      expect(recoveries).toBe(0)
    },
  )

  test('late startup failure retains recovery after its sole exact cleanup is unconfirmed', async () => {
    const state = { attempted: false, confirmed: false }
    let cleanupCalls = 0
    const exactCleanup = async () => {
      cleanupCalls += 1
      return false
    }

    await expect(attemptProcessCleanupOnce(state, exactCleanup)).resolves.toBe(false)
    await expect(attemptProcessCleanupOnce(state, exactCleanup)).resolves.toBe(false)

    expect(state).toEqual({ attempted: true, confirmed: false })
    expect(cleanupCalls).toBe(1)
    expect(shouldRetainProcessRecoveryBlocker({
      childWasSpawned: true,
      cleanupConfirmed: state.confirmed,
    })).toBe(true)
  })
})
