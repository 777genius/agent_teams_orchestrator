import { expect, spyOn, test } from 'bun:test'
import { runtimeOpenCodeCommand } from './runtimeOpenCodeCommand.js'
import * as factory from '../../services/opencode/bridge/OpenCodeRuntimeAdapterFactory.js'
import * as plans from '../../services/opencode/bridge/OpenCodeV2LaunchPlan.js'
import * as probes from '../../services/opencode/bridge/OpenCodeV2ExecutionProbe.js'

for (const cancelledStage of ['selection', 'source', 'probe'] as const) {
  test(`CLI cancellation reaches V2 ${cancelledStage} before subsequent model work`, async () => {
    const listeners = new Map<string, () => void>(), signals: AbortSignal[] = []
    const entered: string[] = [], exits: number[] = []
    let notifyBlocked!: () => void
    const blocked = new Promise<void>(resolve => { notifyBlocked = resolve })
    const waitForCancellation = async (stage: string, signal?: AbortSignal): Promise<never> => {
      entered.push(stage)
      expect(signal).toBeInstanceOf(AbortSignal)
      signals.push(signal!)
      if (stage !== cancelledStage) throw Error('TEST unexpected cancellation boundary')
      notifyBlocked()
      return new Promise((_resolve, reject) => {
        if (signal!.aborted) reject(signal!.reason)
        else signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    }
    const selection = spyOn(factory, 'inspectOpenCodeRuntimeAdapterSelection').mockImplementation(async signal => {
      if (cancelledStage === 'selection') return waitForCancellation('selection', signal)
      return { path: '/TEST/opencode', policy: { generation: 'v2', version: '2.1.4', dialect: 'v2-2.1.4' },
        native: null, fingerprint: 'TEST-fingerprint' }
    })
    const source = spyOn(plans, 'inspectOpenCodeV2SourceAvailability').mockImplementation(async (_envelope, budget) => {
      if (cancelledStage === 'source') return waitForCancellation('source', budget?.signal)
      // Only the signal crosses this fixture boundary; no native selection is qualified.
      return {} as Awaited<ReturnType<typeof plans.inspectOpenCodeV2SourceAvailability>>
    })
    const probe = spyOn(probes, 'resolveOpenCodeV2ExecutionProbe').mockImplementation(async (_envelope, _selection, _run, options) =>
      waitForCancellation('probe', options?.signal))
    let cleanups = 0, writes = 0
    const command = runtimeOpenCodeCommand({ input: '/TEST/input' }, {
      readInput: async () => JSON.stringify({ schemaVersion: 1, requestId: 'TEST-cancel', command: 'opencode.readiness',
        cwd: '/TEST/project', startedAt: new Date().toISOString(), timeoutMs: 30_000,
        body: { selectedModel: 'openrouter/TEST-model', requireExecutionProbe: true } }),
      onSignal: (signal, listener) => { listeners.set(signal, listener) },
      offSignal: signal => { listeners.delete(signal) },
      drainCleanup: async () => { cleanups++ },
      writePayload: async () => { writes++ },
      exit: code => { exits.push(code) },
    })
    try {
      await blocked
      listeners.get('SIGTERM')!()
      await command
      expect(entered).toEqual([cancelledStage])
      expect(signals.every(signal => signal.aborted)).toBe(true)
      expect(exits).toEqual([143])
      expect(cleanups).toBe(1)
      expect(writes).toBe(0)
      if (cancelledStage === 'selection') expect(source).not.toHaveBeenCalled()
      if (cancelledStage !== 'probe') expect(probe).not.toHaveBeenCalled()
    } finally {
      selection.mockRestore(); source.mockRestore(); probe.mockRestore()
    }
  })
}
