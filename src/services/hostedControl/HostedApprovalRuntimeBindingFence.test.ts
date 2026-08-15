import { describe, expect, test } from 'bun:test'

import { HostedApprovalRuntimeBindingFence } from './HostedApprovalRuntimeBindingFence.js'

describe('HostedApprovalRuntimeBindingFence', () => {
  test('serializes controlled writes behind the single transition pin', async () => {
    const fence = new HostedApprovalRuntimeBindingFence()
    const pin = fence.tryAcquirePin()
    expect(pin).not.toBeNull()
    if (!pin) throw new Error('expected binding pin')
    expect(pin.isCurrent()).toBe(true)
    expect(fence.tryAcquirePin()).toBeNull()
    const order: string[] = []
    await expect(pin.capture(async () => 'snapshot')).resolves.toBe('snapshot')
    const mutation = fence.write(async () => { order.push('write'); return 3 })
    await Promise.resolve()
    expect(order).toEqual([])
    pin.release()
    expect(await mutation).toBe(3)
    expect(order).toEqual(['write'])
    expect(pin.isCurrent()).toBe(false)
    await expect(pin.capture(async () => 'stale')).rejects.toThrow('not current')
  })

  test('releases capture and write fences on failure', async () => {
    const fence = new HostedApprovalRuntimeBindingFence()
    await expect(fence.capture(async () => { throw new Error('capture failed') }))
      .rejects.toThrow('capture failed')
    await expect(fence.withWriteFence(async () => 'current')).resolves.toBe('current')
    expect(fence.tryAcquirePin()).not.toBeNull()
  })

  test('rejects a pin issued by another team fence', async () => {
    const first = new HostedApprovalRuntimeBindingFence()
    const second = new HostedApprovalRuntimeBindingFence()
    const pin = first.tryAcquirePin()
    if (!pin) throw new Error('expected binding pin')
    await expect(second.capturePinned(pin, async () => 'wrong team'))
      .rejects.toThrow('another fence')
    pin.release()
  })
})
