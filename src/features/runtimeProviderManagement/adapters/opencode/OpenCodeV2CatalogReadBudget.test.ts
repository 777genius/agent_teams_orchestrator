import { expect, spyOn, test } from 'bun:test'
import { OpenCodeV2CatalogReadBudget, OpenCodeV2CatalogReadTimeout } from './OpenCodeV2CatalogReadBudget.js'

const waitForAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason)
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})

test('one catalog budget includes preparation instead of restarting at acquisition', async () => {
  const budget = new OpenCodeV2CatalogReadBudget(30)
  const events: string[] = []
  const result = budget.run(async current => {
    current.enter('receipt')
    await waitForAbort(current.signal)
    events.push('acquire')
  })
  await expect(result).rejects.toThrow(/catalog timed out during receipt.*budget 30ms/)
  expect(events).toEqual([])
})

test('timeout cancels owned acquisition but waits for its cleanup before reporting failure', async () => {
  const budget = new OpenCodeV2CatalogReadBudget(30)
  let release!: () => void
  const cleanup = new Promise<void>(resolve => { release = resolve })
  const events: string[] = []
  const result = budget.run(async current => {
    current.enter('acquisition')
    try { await waitForAbort(current.signal) }
    finally { current.retiring(); events.push('retire'); await cleanup; events.push('retired') }
  })
  let settled = false
  void result.catch(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 45))
  expect(events).toEqual(['retire'])
  expect(settled).toBe(false)
  release()
  await expect(result).rejects.toThrow(/timed out during acquisition/)
  expect(events).toEqual(['retire', 'retired'])
})

test('unknown cleanup remains attached to timeout and never becomes success', async () => {
  const budget = new OpenCodeV2CatalogReadBudget(20)
  const retainedCustody = new Error('provider_physical_cleanup_unknown')
  const result = budget.run(async current => {
    current.enter('models')
    try { await waitForAbort(current.signal) }
    finally { current.retiring(); throw retainedCustody }
  })
  try { await result; throw new Error('unexpected success') }
  catch (error) {
    expect(error).toBeInstanceOf(OpenCodeV2CatalogReadTimeout)
    expect((error as Error).cause).toBe(retainedCustody)
    expect((error as Error).message).toContain('during models')
  }
})

for (const transition of ['next phase', 'retirement'] as const) test(`elapsed work keeps its timeout phase before ${transition}`, async () => {
  const clock = spyOn(performance, 'now').mockReturnValue(0)
  const budget = new OpenCodeV2CatalogReadBudget(30)
  try {
    await expect(budget.run(async current => {
      current.enter('receipt')
      // Synchronous work or a microtask chain can consume the budget before
      // its timer runs; the following phase did not consume that time.
      clock.mockReturnValue(31)
      if (transition === 'retirement') current.retiring()
      else current.enter('acquisition')
    })).rejects.toThrow(/catalog timed out during receipt/)
  } finally { clock.mockRestore() }
})
