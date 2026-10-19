import { expect, test } from 'bun:test'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { verifyOpenCodePackage, verifyOpenCodeV2GraphEffect, verifyOpenCodeV2ServerGraph } from '../../src/services/opencode/host/OpenCodeV2ServerGraph.js'
import { readShellProbeResult, shellProbeConfig, shellProbeFailure, type ShellProbeResult } from './windows-shell-tool-contract.js'

test('the exact no-model document decodes with the verified selected config schema', async () => {
  const graph = await verifyOpenCodeV2ServerGraph('2.0.32')
  const entry = await realpath(Bun.resolveSync('@opencode/schema/config', path.dirname(graph.modulePath)))
  await verifyOpenCodePackage(entry, '@opencode/schema', '2.0.32')
  await verifyOpenCodeV2GraphEffect(entry, graph.effectPath, '2.0.32')
  const { Schema }: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
  const { Config }: typeof import('@opencode/schema/config') = await import(pathToFileURL(entry).href)
  const decoded = Schema.decodeUnknownSync(Config.Info)(shellProbeConfig)
  expect(decoded.default_agent).toBe('TEST-shell-agent')
  expect(decoded.agents?.['TEST-shell-agent']?.permissions).toEqual(shellProbeConfig.agents['TEST-shell-agent'].permissions)
})

test('selected stable Effect failure retains only the adapter method through tool/process wrappers', async () => {
  const graph = await verifyOpenCodeV2ServerGraph('2.0.32')
  const { Effect, Exit, PlatformError }: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
  const original = PlatformError.systemError({ _tag: 'Unknown', module: 'ChildProcess', method: 'resolve',
    description: 'Windows owned command operation failed' })
  expect(original.message).toBe('Unknown: ChildProcess.resolve: Windows owned command operation failed')
  const wrapper = { _tag: 'ToolFailure', error: { _tag: 'AppProcessError', cause: original } }
  const exit = await Effect.runPromiseExit(Effect.fail(wrapper))
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error('TEST_expected_failure')
  expect(shellProbeFailure(exit.cause)).toEqual({ kind: 'Fail', method: 'resolve' })
  expect(exit.cause.reasons[0]).toMatchObject({ error: wrapper })
  const die = await Effect.runPromiseExit(Effect.die(original))
  if (!Exit.isFailure(die)) throw new Error('TEST_expected_defect')
  expect(shellProbeFailure(die.cause)).toEqual({ kind: 'Die', method: 'resolve' })
})

test('finite failure projector ignores other leaves, unknown methods, raw fields and accessors', () => {
  let reads = 0
  const hostile = Object.defineProperty({}, 'reason', { get() { reads++; throw new Error('TEST_getter') } })
  expect(shellProbeFailure({ reasons: [{ _tag: 'Fail', error: hostile }] })).toEqual({ kind: 'Fail', method: null })
  expect(reads).toBe(0)
  const later = { _tag: 'PlatformError', reason: { _tag: 'Unknown', module: 'ChildProcess', method: 'spawn',
    description: 'Windows owned command operation failed' } }
  expect(shellProbeFailure({ reasons: [{ _tag: 'Fail', error: {} }, { _tag: 'Fail', error: later }] }))
    .toEqual({ kind: 'Fail', method: null })
  expect(shellProbeFailure(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('TEST_proxy') } })))
    .toEqual({ kind: 'unknown', method: null })
  const cycle: { cause?: object } = {}; cycle.cause = cycle
  expect(shellProbeFailure({ reasons: [{ _tag: 'Fail', error: cycle }] })).toEqual({ kind: 'Fail', method: null })
})

test('child result admission strips extras and requires actual complete evidence for a positive', () => {
  const positive: ShellProbeResult = { stage: 'complete', succeeded: true, sessionCreated: true, registeredShell: true,
    shell: 'cmd', markerPresent: true, failure: null }
  expect(readShellProbeResult({ ...positive, command: 'TEST-private', output: 'TEST-private' })).toEqual(positive)
  expect(readShellProbeResult({ ...positive, markerPresent: false })).toBeUndefined()
  expect(readShellProbeResult({ ...positive, stage: 'tool-execute' })).toBeUndefined()
  expect(readShellProbeResult({ ...positive, failure: { kind: 'Fail', method: 'resolve' } })).toBeUndefined()
  expect(readShellProbeResult({ ...positive, shell: { toString() { throw new Error('TEST_coercion') } } })).toBeUndefined()
  expect(readShellProbeResult({ ...positive, failure: { kind: 'Fail', method: 'raw-method' }, succeeded: false })).toBeUndefined()
})
