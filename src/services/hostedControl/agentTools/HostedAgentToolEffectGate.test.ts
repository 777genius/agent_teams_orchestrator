import { describe, expect, test } from 'bun:test'

import { HostedAgentToolEffectGate } from './HostedAgentToolEffectGate.js'

describe('HostedAgentToolEffectGate', () => {
  test('revoke waits for a started effect and fences queued stale calls', async () => {
    const gate = new HostedAgentToolEffectGate()
    let releaseEffect!: () => void
    const effectHeld = new Promise<void>(resolve => { releaseEffect = resolve })
    let enteredEffect!: () => void
    const effectEntered = new Promise<void>(resolve => { enteredEffect = resolve })
    const events: string[] = []
    const first = gate.withCurrentMemberEffect(() => true, async () => {
      events.push('effect-start')
      enteredEffect()
      await effectHeld
      events.push('effect-end')
      return 'receipt'
    })
    await effectEntered
    const stale = gate.withCurrentMemberEffect(() => true, async () => {
      events.push('stale-effect')
      return 'wrong'
    })
    const transition = gate.transition(async () => { events.push('revoke') })
    await Bun.sleep(0)
    expect(events).toEqual(['effect-start'])
    releaseEffect()
    expect(await first).toEqual({ kind: 'applied', value: 'receipt' })
    expect(await stale).toEqual({ kind: 'unavailable' })
    await transition
    expect(events).toEqual(['effect-start', 'effect-end', 'revoke'])
  })

  test('reassignment rechecks current member inside gate; close rejects and drains', async () => {
    const gate = new HostedAgentToolEffectGate()
    let current = true
    await gate.transition(async () => { current = false })
    let effects = 0
    expect(await gate.withCurrentMemberEffect(() => current, async () => { effects++; return 'wrong' }))
      .toEqual({ kind: 'unavailable' })
    expect(effects).toBe(0)
    await gate.close()
    expect(await gate.withCurrentMemberEffect(() => true, async () => { effects++; return 'wrong' }))
      .toEqual({ kind: 'unavailable' })
    expect(effects).toBe(0)
  })

  test('failed ownership transition leaves tool effects fenced', async () => {
    const gate = new HostedAgentToolEffectGate()
    const failed = gate.transition(async () => { throw new Error('stop failed') })
    const failedRejection = expect(failed).rejects.toThrow('stop failed')
    let queuedTransitions = 0
    const queued = gate.transition(async () => { queuedTransitions++ })
    const queuedRejection = expect(queued).rejects.toThrow('closed')
    await failedRejection
    await queuedRejection
    expect(queuedTransitions).toBe(0)
    let effects = 0
    expect(await gate.withCurrentMemberEffect(() => true, async () => { effects++; return 'wrong' }))
      .toEqual({ kind: 'unavailable' })
    expect(effects).toBe(0)
  })

  test('close cancels a queued transition before its callback can run', async () => {
    const gate = new HostedAgentToolEffectGate()
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const effect = gate.withCurrentMemberEffect(() => true, async () => {
      entered()
      await held
      return 'done'
    })
    await started
    let transitions = 0
    const queued = gate.transition(async () => { transitions++ })
    const closing = gate.close()
    release()
    await effect
    await expect(queued).rejects.toThrow('closed')
    await closing
    expect(transitions).toBe(0)
  })
})
