import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import { FakeOpenCodeRegressionHarness } from './FakeOpenCodeRegressionHarness.js'

describe('FakeOpenCodeRegressionHarness', () => {
  test('journals the fake CLI, host API, sandbox writes, managed plugins, and child cleanup', async () => {
    const harness = await FakeOpenCodeRegressionHarness.create()
    try {
      const cli = harness.fakeCli('catalog')
      const hostApi = harness.fakeHostHttpApi('catalog')
      hostApi.setResponse('GET', '/provider', { connected: ['openrouter'] })
      await cli.exec(['models', '--verbose'])
      await hostApi.request('GET', '/provider')
      await harness.writeSandboxFile('catalog', 'profile/opencode.json', '{}')
      harness.recordManagedPlugin('catalog', 'catalog-prewarm')
      const child = harness.spawnChild('catalog')
      child.cleanup()

      expect(harness.journal).toEqual(expect.objectContaining({
        commands: [{ target: 'catalog', args: ['models', '--verbose'] }],
        filesystemWrites: [{
          target: 'catalog',
          path: path.join(harness.sandboxPath, 'profile/opencode.json'),
        }],
        managedPlugins: [{
          target: 'catalog',
          packageName: 'opencode-kiro@0.4.0',
          action: 'catalog-prewarm',
        }],
        httpRequests: [{ target: 'catalog', method: 'GET', pathname: '/provider' }],
        childProcesses: [
          { target: 'catalog', pid: 41_000, event: 'spawn' },
          { target: 'catalog', pid: 41_000, event: 'cleanup' },
        ],
      }))
    } finally {
      await harness.cleanup()
    }
  })

  test('controls hangs, cancellation, late completion, and timers without real sleeps', async () => {
    const harness = await FakeOpenCodeRegressionHarness.create()
    try {
      const operation = harness.deferred<string>('launch', 'models --verbose attempt 1')
      let timerFired = false
      harness.clock.setTimeout(() => {
        timerFired = true
        operation.cancel()
      }, 30_000)

      expect(await harness.observePromise(operation.promise)).toEqual({ state: 'pending' })
      harness.clock.advanceBy(29_999)
      expect(timerFired).toBe(false)
      harness.clock.advanceBy(1)
      expect(timerFired).toBe(true)
      operation.resolve('late catalog')

      expect(await operation.promise).toBe('late catalog')
      expect(harness.journal.operations).toEqual([
        { target: 'launch', name: 'models --verbose attempt 1', event: 'started' },
        { target: 'launch', name: 'models --verbose attempt 1', event: 'cancelled' },
        { target: 'launch', name: 'models --verbose attempt 1', event: 'late-completion' },
      ])
    } finally {
      await harness.cleanup()
    }
  })

  test('makes outer-retry amplification explicit and deterministic', async () => {
    const harness = await FakeOpenCodeRegressionHarness.create()
    try {
      const cli = harness.fakeCli('catalog')
      const first = harness.deferred<void>('catalog', 'models --verbose attempt 1')
      await cli.exec(['models', '--verbose'])
      first.cancel()
      const second = harness.deferred<void>('catalog', 'models --verbose attempt 2')
      await cli.exec(['models', '--verbose'])

      expect(harness.journal.commands).toEqual([
        { target: 'catalog', args: ['models', '--verbose'] },
        { target: 'catalog', args: ['models', '--verbose'] },
      ])
      expect(await harness.observePromise(first.promise)).toEqual({ state: 'pending' })
      expect(await harness.observePromise(second.promise)).toEqual({ state: 'pending' })

      first.resolve()
      second.resolve()
      await Promise.all([first.promise, second.promise])
      expect(harness.journal.operations.map(event => event.event)).toEqual([
        'started',
        'cancelled',
        'started',
        'late-completion',
        'completed',
      ])
    } finally {
      await harness.cleanup()
    }
  })
})
