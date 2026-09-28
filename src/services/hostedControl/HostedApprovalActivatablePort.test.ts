import { describe, expect, test } from 'bun:test'

import {
  HostedApprovalActivatablePort,
  HostedApprovalPortUnavailableError,
} from './HostedApprovalActivatablePort.js'
import type { HostedApprovalWirePort } from './HostedApprovalWire.js'

describe('HostedApprovalActivatablePort', () => {
  test('fails closed while inactive without presenting an empty successful claim', async () => {
    const port = new HostedApprovalActivatablePort()

    expect(port.lifecycle).toEqual({ status: 'inactive', epoch: 0 })
    await expect(port.claimIngress({} as never)).rejects.toBeInstanceOf(
      HostedApprovalPortUnavailableError,
    )
    expect(await port.acknowledgeIngress({} as never)).toEqual({ status: 'unavailable' })
    expect(await port.getAdmittedIngressAuthority({} as never)).toBeNull()
    expect(await port.resolveIngressAuthority({} as never)).toEqual({ status: 'unavailable' })
    expect(await port.authorizeDecision({} as never)).toEqual({ status: 'unavailable' })
    expect(await port.deliverDecision({} as never)).toEqual({ status: 'unavailable' })
    expect(await port.reconcileDecision({} as never)).toEqual({ status: 'unavailable' })
  })

  test('recovery exposes no delegate observations or effects', async () => {
    const port = new HostedApprovalActivatablePort()
    const guard = port.beginRecovery()

    expect(port.lifecycle).toEqual({ status: 'recovering', epoch: 1 })
    expect(guard.epoch).toBe(1)
    expect(guard.isCurrent()).toBe(true)
    expect(guard.prepareEffectToken()).toBeNull()
    await expect(port.claimIngress({} as never)).rejects.toThrow('unavailable')
    expect(await port.deliverDecision({} as never)).toEqual({ status: 'unavailable' })
  })

  test('installs one delegate synchronously and forwards existing wire operations', async () => {
    const calls: string[] = []
    const port = new HostedApprovalActivatablePort()
    const guard = port.beginRecovery()
    guard.install(delegate({
      claimIngress: () => { calls.push('claim'); return Promise.resolve([{} as never]) },
      acknowledgeIngress: () => {
        calls.push('acknowledge'); return Promise.resolve({ status: 'acknowledged' })
      },
      getAdmittedIngressAuthority: authority => {
        calls.push('get-authority'); return Promise.resolve(authority)
      },
      resolveIngressAuthority: () => {
        calls.push('resolve-authority'); return Promise.resolve({ status: 'resolved', scope: {} as never })
      },
      authorizeDecision: () => {
        calls.push('authorize'); return Promise.resolve({ status: 'unavailable' })
      },
      deliverDecision: () => { calls.push('deliver'); return Promise.resolve({ status: 'delivered' }) },
      reconcileDecision: () => {
        calls.push('reconcile'); return Promise.resolve({ status: 'not_delivered' })
      },
    }))

    expect(port.lifecycle).toEqual({ status: 'active', epoch: 1 })
    expect(await port.claimIngress({} as never)).toHaveLength(1)
    expect(await port.acknowledgeIngress({} as never)).toEqual({ status: 'acknowledged' })
    expect(await port.getAdmittedIngressAuthority({} as never)).toEqual({})
    expect(await port.resolveIngressAuthority({} as never)).toMatchObject({ status: 'resolved' })
    expect(await port.authorizeDecision({} as never)).toEqual({ status: 'unavailable' })
    expect(await port.deliverDecision({} as never)).toEqual({ status: 'delivered' })
    expect(await port.reconcileDecision({} as never)).toEqual({ status: 'not_delivered' })
    expect(calls).toEqual([
      'claim', 'acknowledge', 'get-authority', 'resolve-authority',
      'authorize', 'deliver', 'reconcile',
    ])
  })

  test('accepts a current effect token once and rejects consumed or stale tokens', async () => {
    const port = new HostedApprovalActivatablePort()
    const guard = port.beginRecovery()
    guard.install(delegate())
    const consumed = guard.prepareEffectToken()
    const stale = guard.prepareEffectToken()

    expect(consumed?.epoch).toBe(1)
    expect(consumed?.consume()).toBe(true)
    expect(consumed?.consume()).toBe(false)
    await port.revoke()
    expect(port.lifecycle).toEqual({ status: 'revoked', epoch: 2, sealed: true })
    expect(guard.isCurrent()).toBe(false)
    expect(stale?.consume()).toBe(false)
    expect(guard.prepareEffectToken()).toBeNull()
  })

  test('clears the delegate and increments the epoch before cleanup', async () => {
    const port = new HostedApprovalActivatablePort()
    const guard = port.beginRecovery()
    const installed = delegate()
    guard.install(installed)

    await port.revoke(async removed => {
      expect(removed).toBe(installed)
      expect(port.lifecycle).toEqual({ status: 'revoked', epoch: 2, sealed: true })
      expect(guard.isCurrent()).toBe(false)
      expect(await port.deliverDecision({} as never)).toEqual({ status: 'unavailable' })
    })
  })

  test('does not deliver an authorization obtained before revocation', async () => {
    let effects = 0
    const port = new HostedApprovalActivatablePort()
    const guard = port.beginRecovery()
    guard.install(delegate({
      authorizeDecision: async () => ({
        status: 'authorized',
        authorization: { token: 'authorization', persistedAuthority: {} as never },
      }),
      deliverDecision: async () => { effects += 1; return { status: 'delivered' } },
    }))

    expect((await port.authorizeDecision({} as never)).status).toBe('authorized')
    await port.revoke()
    expect(await port.deliverDecision({} as never)).toEqual({ status: 'unavailable' })
    expect(effects).toBe(0)
  })

  test('seals the process generation and rejects reactivation or stale installation', async () => {
    const port = new HostedApprovalActivatablePort()
    const guard = port.beginRecovery()

    expect(() => port.beginRecovery()).toThrow('more than once')
    await port.revoke()
    expect(() => guard.install(delegate())).toThrow('no longer current')
    expect(() => port.beginRecovery()).toThrow('more than once')
    await port.revoke()
    expect(port.lifecycle).toEqual({ status: 'revoked', epoch: 2, sealed: true })
  })

  test('stays revoked when cleanup fails and preserves already-proven call results', async () => {
    let release!: () => void
    let publicationStarted = false
    const proven = new Promise<void>(resolve => { release = resolve })
    const port = new HostedApprovalActivatablePort()
    const guard = port.beginRecovery()
    guard.install(delegate({
      deliverDecision: async () => {
        publicationStarted = true
        await proven
        return { status: 'delivered' }
      },
    }))

    const publication = port.deliverDecision({} as never)
    expect(publicationStarted).toBe(true)
    await expect(port.revoke(() => { throw new Error('cleanup failed') }))
      .rejects.toThrow('cleanup failed')
    expect(port.lifecycle).toEqual({ status: 'revoked', epoch: 2, sealed: true })
    release()
    await expect(publication).resolves.toEqual({ status: 'delivered' })
    await expect(port.claimIngress({} as never)).rejects.toThrow('unavailable')
  })

  test('rejects an invalid delegate and propagates delegate failures unchanged', async () => {
    const port = new HostedApprovalActivatablePort()
    const guard = port.beginRecovery()
    expect(() => guard.install(null as never)).toThrow(TypeError)
    guard.install(delegate({
      authorizeDecision: async () => { throw new Error('delegate failure') },
    }))

    await expect(port.authorizeDecision({} as never)).rejects.toThrow('delegate failure')
  })
})

function delegate(
  overrides: Partial<HostedApprovalWirePort> = {},
): HostedApprovalWirePort {
  return {
    claimIngress: async () => [],
    acknowledgeIngress: async () => ({ status: 'unavailable' }),
    getAdmittedIngressAuthority: async () => null,
    resolveIngressAuthority: async () => ({ status: 'unavailable' }),
    authorizeDecision: async () => ({ status: 'unavailable' }),
    deliverDecision: async () => ({ status: 'unavailable' }),
    reconcileDecision: async () => ({ status: 'unavailable' }),
    ...overrides,
  }
}
