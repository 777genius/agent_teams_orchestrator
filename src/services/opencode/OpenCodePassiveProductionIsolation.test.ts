import { describe, expect, test } from 'bun:test'

import { executeRuntimeOpenCodeCommandEnvelope } from '../../cli/handlers/runtimeOpenCodeCommand.js'
import { dispatchRuntimeProvidersDirectory } from '../../entrypoints/runtimeProvidersPassiveFastPath.js'
import { buildOpenCodePassiveRuntimeStatus, dispatchOpenCodeRuntimeStatus } from '../runtimeBackends/openCodePassiveStatus.js'
import {
  executeOpenCodePassiveCommandStatusEnvelope,
  type OpenCodePassiveCommandStatusOutcome,
} from './OpenCodePassiveCommandStatusRoute.js'
import { readOpenCodePassiveProviderDirectory } from './OpenCodePassiveProviderDirectory.js'
import {
  createOpenCodePassiveReadSuccess,
  OpenCodePassiveStatusReader,
  openCodePassiveInputPathIdentity,
  type OpenCodePassiveReadHandoff,
} from './OpenCodePassiveStatusReader.js'
import { FakePassiveClock } from './OpenCodePassiveStatusReader.test-support.js'

describe('connected OpenCode passive production dispatchers', () => {
  test('real command, runtime-summary and provider-directory dispatch keep every reachable active seam at zero', async () => {
    const calls = {
      passive: 0,
      binaryRead: 0,
      scopeRead: 0,
      snapshotRead: 0,
      configRead: 0,
      authRead: 0,
      catalogRead: 0,
      executionRead: 0,
      inventory: 0,
      profile: 0,
      host: 0,
      process: 0,
      session: 0,
      write: 0,
      execution: 0,
      plugin: 0,
      oauth: 0,
      activeCommand: 0,
    }
    const fail = (counter: 'inventory' | 'profile' | 'host' | 'process' | 'session' | 'write' | 'execution' | 'plugin' | 'oauth' | 'activeCommand') => (): never => {
      calls[counter] += 1
      throw new Error(`prohibited ${counter}`)
    }
    const clock = new FakePassiveClock()
    const handoff = <T>(callback: OpenCodePassiveReadHandoff<T>, value: T) => {
      callback(createOpenCodePassiveReadSuccess(value, 900, 2_000))
    }
    const reader = new OpenCodePassiveStatusReader({
      clock,
      binaryMetadata: { read: (_signal, callback) => { calls.binaryRead += 1; handoff(callback, { present: true, version: '1.2.3' }) } },
      projectScope: { canonicalize: (projectPath, _signal, callback) => {
        calls.scopeRead += 1
        handoff(callback, { canonicalPath: '/canonical/fake-project', inputPathIdentity: openCodePassiveInputPathIdentity(projectPath) })
      } },
      snapshots: { read: (_scope, _signal, callback) => { calls.snapshotRead += 1; handoff(callback, null) } },
      configMetadata: { read: (providerId, _scope, _signal, callback) => { calls.configRead += 1; handoff(callback, { configured: providerId === 'deepinfra' }) } },
      authMetadata: { read: (_providerId, _scope, _signal, callback) => { calls.authRead += 1; handoff(callback, { lastConnectedAt: null }) } },
      catalogMetadata: { read: (_providerId, _scope, _signal, callback) => { calls.catalogRead += 1; handoff(callback, { available: false }) } },
      executionMetadata: { read: (_providerId, _scope, _signal, callback) => { calls.executionRead += 1; handoff(callback, { verified: false }) } },
    })
    const readPassive = async (input: Parameters<OpenCodePassiveStatusReader['read']>[0]) => {
      calls.passive += 1
      return reader.read(input)
    }
    const outcome: OpenCodePassiveCommandStatusOutcome = {
      requestId: 'send-request', deliveryAttemptId: null, status: 'received', safeToRetry: false,
      sessionId: null, runtimePid: null, runtimePromptMessageId: null, prePromptCursor: null,
    }

    const command = await executeRuntimeOpenCodeCommandEnvelope({
      schemaVersion: 1,
      requestId: 'status-request',
      command: 'opencode.commandStatus',
      cwd: '/fake-project',
      timeoutMs: 25,
      body: { originalRequestId: 'send-request' },
    }, {
      executePassive: input => executeOpenCodePassiveCommandStatusEnvelope(input, {
        now: () => 1_000,
        schedule: () => ({ cancel() {} }),
        readPassiveStatus: readPassive,
        readOutcome: async () => outcome,
      }),
      executeActive: async () => fail('activeCommand')(),
    })

    const runtime = await dispatchOpenCodeRuntimeStatus('summary', {
      readPassive: () => buildOpenCodePassiveRuntimeStatus({
        getOpenCodePassiveStatus: readPassive,
        now: () => 1_000,
        schedule: () => ({ cancel() {} }),
      }),
      readActive: async () => fail('inventory')(),
    })

    const directory = await dispatchRuntimeProvidersDirectory({
      command: 'directory', summary: true, runtime: 'opencode',
    }, {
      readPassive: async () => {
        const result = await readOpenCodePassiveProviderDirectory({
          projectPath: '/fake-project', query: 'deepinfra', limit: 5, timeoutMs: 25,
        }, readPassive, { now: () => 1_000, schedule: () => ({ cancel() {} }) })
        return { runtimeId: 'opencode', result }
      },
      // This represents the entry point's real active directory composition. A
      // regression into it makes every distinct active category observable.
      readActive: async () => {
        for (const counter of ['inventory', 'profile', 'host', 'process', 'session', 'write', 'execution', 'plugin', 'oauth'] as const) {
          calls[counter] += 1
        }
        throw new Error('unreachable')
      },
    })

    expect(command).toMatchObject({ ok: true, data: { status: 'received', accepted: false } })
    expect(runtime).toMatchObject({
      authenticated: false,
      capabilities: { teamLaunch: false },
      models: [],
    })
    expect(directory.runtimeId).toBe('opencode')
    expect(directory.result.entries).toHaveLength(1)
    expect(directory.result.entries[0]).toMatchObject({
      providerId: 'deepinfra', state: 'not-connected', connectedAuthHint: null,
      modelCount: null, defaultModelId: null,
      metadata: { hasKnownModels: false, configuredAuthless: false },
    })
    expect(directory.result.entries[0]?.actions.every(action => !action.enabled)).toBe(true)
    expect(calls).toEqual({
      passive: 3,
      binaryRead: 3,
      scopeRead: 3,
      snapshotRead: 3,
      configRead: 81,
      authRead: 81,
      catalogRead: 81,
      executionRead: 81,
      inventory: 0,
      profile: 0,
      host: 0,
      process: 0,
      session: 0,
      write: 0,
      execution: 0,
      plugin: 0,
      oauth: 0,
      activeCommand: 0,
    })
  })
})
