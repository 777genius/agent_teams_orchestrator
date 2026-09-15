import { describe, expect, test } from 'bun:test'

import { QueryGuard } from './QueryGuard.js'

describe('QueryGuard continuation tickets', () => {
  test('reserves a continuation only while idle on the current instance/generation', () => {
    const guard = new QueryGuard('runtime-1')
    const first = guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-c1',
      reservationNonce: 'nonce-c1',
    })
    expect(first).toEqual({
      ok: true,
      ticket: {
        runtimeInstanceId: 'runtime-1',
        expectedGeneration: 0,
        reservationNonce: 'nonce-c1',
        intentId: 'intent-c1',
      },
    })
    expect(guard.status).toBe('dispatching')
    expect(
      guard.reserveContinuation({
        runtimeInstanceId: 'runtime-1',
        expectedGeneration: 0,
        intentId: 'intent-c2',
      }),
    ).toEqual({ ok: false, code: 'busy' })
    expect(guard.reserve()).toBe(false)
  })

  test('rejects a continuation from another instance or stale generation', () => {
    const guard = new QueryGuard('runtime-1')
    expect(
      guard.reserveContinuation({
        runtimeInstanceId: 'runtime-2',
        expectedGeneration: 0,
        intentId: 'intent-c1',
      }),
    ).toEqual({ ok: false, code: 'instance_mismatch' })
    expect(guard.tryStart()).toBe(1)
    guard.end(1)
    expect(
      guard.reserveContinuation({
        runtimeInstanceId: 'runtime-1',
        expectedGeneration: 0,
        intentId: 'intent-c1',
      }),
    ).toEqual({ ok: false, code: 'instance_mismatch' })
  })

  test('starts only the matching continuation ticket and increments generation', () => {
    const guard = new QueryGuard('runtime-1')
    const reserved = guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-c1',
      reservationNonce: 'nonce-c1',
    })
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) return
    expect(
      guard.startReservedContinuation({
        ...reserved.ticket,
        intentId: 'intent-other',
      }),
    ).toEqual({ ok: false, code: 'stale' })
    expect(guard.startReservedContinuation(reserved.ticket)).toEqual({
      ok: true,
      generation: 1,
    })
    expect(guard.status).toBe('running')
    expect(guard.continuationTicket).toBeNull()
    expect(guard.startReservedContinuation(reserved.ticket)).toEqual({
      ok: false,
      code: 'busy',
    })
  })

  test('user tryStart drops a pending continuation ticket', () => {
    const guard = new QueryGuard('runtime-1')
    guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-c1',
      reservationNonce: 'nonce-c1',
    })
    expect(guard.tryStart()).toBe(1)
    expect(guard.continuationTicket).toBeNull()
    expect(guard.status).toBe('running')
  })

  test('ordinary cancelReservation does not drop a continuation ticket', () => {
    const guard = new QueryGuard('runtime-1')
    const reserved = guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-c2',
      reservationNonce: 'nonce-c2',
    })
    expect(reserved.ok).toBe(true)
    guard.cancelReservation()
    expect(guard.status).toBe('dispatching')
    expect(guard.continuationTicket?.intentId).toBe('intent-c2')
  })

  test('late cancelReservation after user start does not idle a newer continuation', () => {
    const first = new QueryGuard('runtime-1')
    first.reserve()
    expect(first.tryStart()).toBe(1)
    first.end(1)
    const reserved = first.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 1,
      intentId: 'intent-c2',
      reservationNonce: 'nonce-c2',
    })
    expect(reserved.ok).toBe(true)
    first.cancelReservation()
    expect(first.status).toBe('dispatching')
    expect(first.continuationTicket?.intentId).toBe('intent-c2')
  })

  test('stale end does not release a newer running query', () => {
    const guard = new QueryGuard('runtime-1')
    expect(guard.tryStart()).toBe(1)
    guard.forceEnd()
    expect(guard.tryStart()).toBe(3)
    expect(guard.end(1)).toBe(false)
    expect(guard.status).toBe('running')
    expect(guard.end(3)).toBe(true)
    expect(guard.status).toBe('idle')
  })

  test('forceEnd invalidates an idle leftover continuation ticket', () => {
    const guard = new QueryGuard('runtime-1')
    const reserved = guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-c1',
      reservationNonce: 'nonce-c1',
    })
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) return
    expect(guard.cancelReservedContinuation(reserved.ticket)).toBe('cancelled')
    expect(guard.status).toBe('idle')
    guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-idle',
      reservationNonce: 'nonce-idle',
    })
    guard.forceEnd()
    expect(guard.continuationTicket).toBeNull()
    expect(guard.status).toBe('idle')
    expect(guard.generation).toBe(1)
  })

  test('late startReservedContinuation after cancel is stale and does not start the model', () => {
    const guard = new QueryGuard('runtime-1')
    const reserved = guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-c1',
      reservationNonce: 'nonce-c1',
    })
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) return
    expect(guard.cancelReservedContinuation(reserved.ticket)).toBe('cancelled')
    expect(guard.startReservedContinuation(reserved.ticket)).toEqual({
      ok: false,
      code: 'stale',
    })
    expect(guard.status).toBe('idle')
    expect(guard.generation).toBe(0)
  })

  test('user submit invalidation clears dispatching continuation for ordinary reserve', () => {
    const guard = new QueryGuard('runtime-1')
    guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-c1',
      reservationNonce: 'nonce-c1',
    })
    expect(guard.invalidateContinuationForUserSubmit()).toBe(true)
    expect(guard.status).toBe('idle')
    expect(guard.reserve()).toBe(true)
    expect(guard.continuationTicket).toBeNull()
  })

  test('expires a reserved continuation so ordinary user submit can proceed', () => {
    const guard = new QueryGuard('runtime-1')
    guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-c1',
      reservationNonce: 'nonce-c1',
      expiresAtMs: Date.now() - 1,
    })
    expect(guard.expireReservedContinuation(Date.now())).toBe(true)
    expect(guard.status).toBe('idle')
    expect(guard.continuationTicket).toBeNull()
    expect(guard.reserve()).toBe(true)
  })
})
