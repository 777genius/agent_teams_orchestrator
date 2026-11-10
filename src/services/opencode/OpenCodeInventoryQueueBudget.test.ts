import { expect, spyOn, test } from 'bun:test'
import { OpenCodeProviderManagementAdapter } from '../../features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.js'
import { createOpenCodeInventoryProbeProgressTracker, withOpenCodeInventoryProbeTimeout } from './OpenCodeInventoryService.js'
import type { OpenCodeInventorySnapshot } from './types.js'

function clock() {
  let now = 0, sequence = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const monotonic = spyOn(performance, 'now').mockImplementation(() => now)
  const schedule = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms = 0) => {
    const id = ++sequence
    timers.set(id, { at: now + ms, callback })
    return id
  }) as unknown as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(id => { timers.delete(Number(id)) })
  return {
    async advance(target: number) {
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at; timers.delete(next[0]); next[1].callback()
        await Promise.resolve(); await Promise.resolve()
      }
      now = target
    },
    pending: () => timers.size,
    restore: () => { clear.mockRestore(); schedule.mockRestore(); monotonic.mockRestore() },
  }
}

test('command-lock queueing excludes only waiting, retaining the original work and cleanup budget', async () => {
  const time = clock()
  let queue!: (waiting: boolean) => void, expired = false
  const progress = createOpenCodeInventoryProbeProgressTracker()
  progress.enterStep('prepare profile')
  try {
    const result = withOpenCodeInventoryProbeTimeout(onQueue => {
      queue = onQueue
      return new Promise(() => {})
    }, { timeoutMs: 30_000, progress, onTimeout: () => { expired = true } })
    await time.advance(10_000)
    queue(true)
    await time.advance(130_000)
    expect(expired).toBe(false)
    queue(false)
    progress.enterStep('clean up OpenCode inventory command')
    await time.advance(149_999)
    expect(expired).toBe(false)
    await time.advance(150_000)
    expect((await result).probeError).toContain('after 30000ms during clean up OpenCode inventory command')
    expect(expired).toBe(true)
    queue(false)
    expect(time.pending()).toBe(0)
  } finally { time.restore() }
})

test('queued summaries return their unchanged provider evidence after waiting beyond thirty seconds', async () => {
  const time = clock()
  let queue!: (waiting: boolean) => void, finish!: (snapshot: OpenCodeInventorySnapshot) => void
  // The wrapper must return the actual snapshot, without reconstructing or reducing metadata.
  const snapshot: OpenCodeInventorySnapshot = { detected: true, binaryPath: '/TEST/opencode', version: '1.18.34',
    projectPath: '/TEST/queue-budget', profile: null, connectedProviders: [{ id: 'google', source: 'environment', authHint: 'api' },
    { id: 'openai', source: 'credentials', authHint: 'oauth' }], availableProviders: ['google', 'openai'],
    models: [], agents: [], authStorePath: null, probeError: null, diagnostics: ['registered catalog'] }
  try {
    const result = withOpenCodeInventoryProbeTimeout(onQueue => {
      queue = onQueue
      return new Promise(resolve => { finish = resolve })
    }, { timeoutMs: 30_000 })
    queue(true)
    await time.advance(90_000)
    queue(false)
    await time.advance(100_000)
    finish(snapshot)
    expect(await result).toBe(snapshot)
    expect(time.pending()).toBe(0)
  } finally { time.restore() }
})

test('the directory outer deadline aborts a queued summary and releases the paused timer', async () => {
  const time = clock()
  let started!: () => void, aborted = false
  const entered = new Promise<void>(resolve => { started = resolve })
  const adapter = new OpenCodeProviderManagementAdapter({ viewTimeoutMs: 180_000,
    inventoryService: { probe: async (_projectPath, options) => {
      expect(options?.onCommandLockWaitChanged).toBeDefined()
      options!.onCommandLockWaitChanged!(true)
      started()
      return new Promise<OpenCodeInventorySnapshot>((_resolve, reject) => {
        options!.abortSignal!.addEventListener('abort', () => {
          aborted = true
          options!.onCommandLockWaitChanged!(false)
          reject(options!.abortSignal!.reason)
        }, { once: true })
      })
    } },
  })
  try {
    const loading = adapter.loadDirectory({ runtimeId: 'opencode', projectPath: '/TEST/queue-budget', summary: true })
    await entered
    await time.advance(179_999)
    expect(aborted).toBe(false)
    await time.advance(180_000)
    expect((await loading).ok).toBe(false)
    expect(aborted).toBe(true)
    expect(time.pending()).toBe(0)
  } finally { time.restore() }
})

test('a nonqueued summary still expires at thirty seconds', async () => {
  const time = clock()
  try {
    const result = withOpenCodeInventoryProbeTimeout(new Promise(() => {}), { timeoutMs: 30_000 })
    await time.advance(30_000)
    expect((await result).probeError).toContain('after 30000ms')
    expect(time.pending()).toBe(0)
  } finally { time.restore() }
})
