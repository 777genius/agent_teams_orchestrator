import { expect, spyOn, test } from 'bun:test'
import { OpenCodeBoundedFetch } from './OpenCodeBoundedFetch.js'

const base = 'http://127.0.0.1:12345'
const directory = '/TEST-loading-budget'
const json = () => Response.json({ ok: true })

test('catalog reads share three minutes instead of restarting the budget at each request', async () => {
  let now = 1_000_000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const wire = new OpenCodeBoundedFetch(base, '2.1.4', directory, 'Basic TEST', {}, async () => json())
  try {
    const deadline = now + 180_000
    expect(wire.deadline).toBe(deadline)
    now += 90_000
    expect((await wire.fetch(`${base}/api/info`)).ok).toBe(true)
    now += 89_999
    expect((await wire.fetch(`${base}/api/model?location[directory]=${encodeURIComponent(directory)}`)).ok).toBe(true)
    expect(wire.deadline).toBe(deadline)
    now++
    await expect(wire.fetch(`${base}/api/info`)).rejects.toThrow('timeout')
  } finally { await wire.dispose(); clock.mockRestore() }
})

test('initialization and model reads use the remaining parent allowance, not a hidden 15/30s cap', async () => {
  const nativeTimer = globalThis.setTimeout
  const delays: number[] = []
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    delays.push(ms ?? 0)
    return nativeTimer(callback, ms, ...args)
  }) as typeof setTimeout)
  const wire = new OpenCodeBoundedFetch(base, '2.1.4', directory, 'Basic TEST',
    { remainingMs: () => 170_000 }, async () => json())
  try {
    for (const route of ['location', 'integration', 'model']) {
      delays.length = 0
      expect((await wire.fetch(`${base}/api/${route}?location[directory]=${encodeURIComponent(directory)}`)).ok).toBe(true)
      expect(delays.length).toBeGreaterThan(0)
      expect(delays.every(ms => ms > 160_000 && ms <= 170_000)).toBe(true)
    }
  } finally { await wire.dispose(); timer.mockRestore() }
})

test('a shorter caller deadline still rejects a late response', async () => {
  let now = 1_000_000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const deadline = now + 40_000
  const wire = new OpenCodeBoundedFetch(base, '2.1.4', directory, 'Basic TEST',
    { remainingMs: () => deadline - now }, async () => { now += 40_001; return json() })
  try {
    expect(wire.deadline).toBe(deadline)
    await expect(wire.fetch(`${base}/api/info`)).rejects.toThrow('timeout')
  } finally { await wire.dispose(); clock.mockRestore() }
})

test('caller cancellation rejects a late body and joins its cancellation', async () => {
  const controller = new AbortController()
  let release!: (value: Response) => void, cancelled = false
  const response = new Promise<Response>(resolve => { release = resolve })
  const wire = new OpenCodeBoundedFetch(base, '2.1.4', directory, 'Basic TEST',
    { signal: controller.signal }, async () => response)
  try {
    const work = wire.fetch(`${base}/api/info`)
    void work.catch(() => undefined)
    controller.abort()
    release(new Response(new ReadableStream({ cancel() { cancelled = true } })))
    await expect(work).rejects.toThrow('timeout')
    await wire.dispose()
    expect(cancelled).toBe(true)
  } finally { await wire.dispose() }
})
