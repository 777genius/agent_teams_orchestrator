import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateOpenCodeReadEnvironment } from '../profile/OpenCodeV2ManagedConfig.js'
import { boundOpenCodeRead } from './OpenCodeBoundedFetch.js'
import { OpenCodeV2ExecutionFetch, ExecutionTransportFailure, executionWasNotSubmitted, executionSessionIsMissing } from './OpenCodeV2ExecutionFetch.js'

// These fail if loss triggers a replay, deadlines stop at headers, cleanup does
// not cancel real response bodies, or a truncated SSE/foreign location is used.
test('response loss retains one admission, original readback and actual socket cancellation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-execution-node-peer-'))
  await Promise.all(['home', 'tmp', 'config', 'data', 'cache', 'state', 'appdata', 'localappdata'].map(name => mkdir(path.join(root, name))))
  const fixture = fileURLToPath(new URL('./OpenCodeV2ExecutionPeer.ts', import.meta.url))
  const node = process.env.TEST_OPENCODE_NODE_BINARY ?? 'node'
  if (node !== 'node' && !path.isAbsolute(node)) throw new Error('TEST Node override must be absolute')
  const peer = spawn(node, ['--experimental-strip-types', fixture], { cwd: root,
    env: privateOpenCodeReadEnvironment(root), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = new Promise<number | null>((resolve, reject) => { peer.once('close', resolve); peer.once('error', reject) })
  let readyResolve: (port: number) => void = () => undefined, closedResolve: () => void = () => undefined
  const ready = new Promise<number>(resolve => { readyResolve = resolve })
  const bodyClosed = new Promise<void>(resolve => { closedResolve = resolve })
  let mutations = 0, stderr = '', passed = false
  const wires: OpenCodeV2ExecutionFetch[] = []
  peer.stderr?.on('data', (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-4096) })
  peer.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('kind' in message)) return
    if (message.kind === 'ready' && 'nativeNode' in message && message.nativeNode === true &&
      'port' in message && typeof message.port === 'number') readyResolve(message.port)
    if (message.kind === 'admitted' && 'mutations' in message && typeof message.mutations === 'number') mutations = message.mutations
    if (message.kind === 'body_closed') closedResolve()
  })
  try {
    const port = await boundOpenCodeRead(Promise.race([ready, exited.then(() => { throw new Error('peer exited') })]), 5000)
    const base = `http://127.0.0.1:${port}`
    const make = (pin: '2.0.0' | '2.0.21' = '2.0.21', ms = 2000, signal?: AbortSignal) => {
      const wire = new OpenCodeV2ExecutionFetch(base, pin, '/TEST', 'TEST-private', { deadline: Date.now() + ms, signal })
      wires.push(wire); return wire
    }
    const aborted = new AbortController(); aborted.abort()
    const pre = make('2.0.21', 2000, aborted.signal)
    const absent = await pre.fetch(`${base}/api/session/ses_original/prompt`, { method: 'POST', body: '{}' }).catch(error => error)
    expect(executionWasNotSubmitted(absent)).toBe(true)
    const sdkWrapped = Object.assign(new Error('Transport', { cause: absent }), { name: 'ClientError', reason: 'Transport' })
    expect(executionWasNotSubmitted(sdkWrapped)).toBe(true)
    expect(executionWasNotSubmitted(Object.assign(new Error('Transport', { cause: new Error('not submitted') }), { name: 'ClientError', reason: 'Transport' }))).toBe(false)
    expect(mutations).toBe(0)

    const wire = make()
    const lost = await wire.fetch(`${base}/api/session/ses_original/prompt`, {
      method: 'POST', body: JSON.stringify({ id: 'msg_original', text: 'one input', delivery: 'queue', resume: false }),
    }).catch(error => error)
    expect(lost).toBeInstanceOf(ExecutionTransportFailure)
    expect(lost.disposition).toBe('unknown')
    expect(executionWasNotSubmitted(lost)).toBe(false)
    const recovered: unknown = await (await wire.fetch(`${base}/api/session/ses_original/inbox`)).json()
    expect(recovered).toEqual([{ id: 'msg_original', sessionID: 'ses_original', type: 'user',
      time: { created: 123 }, payload: { text: 'one input' }, delivery: 'queue' }])
    expect(mutations).toBe(1)
    for (const scenario of ['html', 'json', 'void']) {
      const failure = await make().fetch(`${base}/api/session/ses_${scenario}/prompt`, { method: 'POST',
        body: JSON.stringify({ id: `msg_${scenario}`, text: 'one input', delivery: 'queue', resume: false }) }).catch(error => error)
      expect(failure).toBeInstanceOf(ExecutionTransportFailure)
      expect(failure.disposition).toBe('unknown')
      expect(executionWasNotSubmitted(failure)).toBe(false)
    }

    const stalled = make('2.0.21', 150)
    await expect(stalled.fetch(`${base}/api/info`)).rejects.toBeInstanceOf(ExecutionTransportFailure)
    await stalled.dispose()
    await boundOpenCodeRead(bodyClosed, 2000) // Independently observed socket close, before teardown.
    expect(peer.exitCode).toBeNull()

    await expect(make().fetch(`${base}/api/experimental/session/ses_original/log?follow=false`)).rejects.toMatchObject({ code: 'incomplete_stream' })
    await expect(make().fetch(`${base}/api/location?location%5Bdirectory%5D=%2Fforeign`)).rejects.toMatchObject({ disposition: 'not_submitted' })
    await expect(make().fetch(`${base}/api/session/ses_original`)).rejects.toMatchObject({ code: 'media_type' })
    const floor = await make('2.0.0').fetch(`${base}/api/plugin/await-activation?location%5Bdirectory%5D=%2FTEST`, { method: 'POST' })
    expect(floor.status).toBe(204)
    expect(await floor.text()).toBe('')
    // Readback receipt has one input; each error scenario used its own intent.
    expect(mutations).toBe(4)
    passed = true
  } finally {
    const cleanup = await Promise.allSettled(wires.map(wire => wire.dispose()))
    if (peer.connected) peer.send({ kind: 'stop' })
    try { expect(await boundOpenCodeRead(exited, 3000)).toBe(0) }
    catch (failure) {
      if (peer.exitCode === null && peer.signalCode === null) peer.kill('SIGKILL')
      await boundOpenCodeRead(exited, 2000)
      throw failure
    }
    if (stderr) throw new Error(`peer stderr; retained ${root}: ${stderr}`)
    if (cleanup.some(result => result.status === 'rejected')) throw new Error(`transport cleanup_unknown; retained ${root}`)
    if (passed) await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test('forbidden mutation and exhausted context prove non-submission without physical requests', async () => {
  let requests = 0
  const wire = new OpenCodeV2ExecutionFetch('http://127.0.0.1:1', '2.0.21', '/TEST', 'TEST',
    { deadline: Date.now() + 1000 }, async () => { requests++; return Response.json({}) })
  try {
    const failure = await wire.fetch('http://127.0.0.1:1/api/session/ses_original/interrupt', { method: 'POST' }).catch(error => error)
    expect(executionWasNotSubmitted(failure)).toBe(true)
    expect(requests).toBe(0)
  } finally { await wire.dispose() }
})

// A non-byte response must be rejected before byte accounting, while preserving
// mutation uncertainty and cancelling/releasing the actual body reader.
test('non-byte mutation response retains uncertainty and cancels its reader', async () => {
  let requests = 0, cancellations = 0
  let signal: AbortSignal | undefined
  const body = new ReadableStream<string>({
    start(controller) { controller.enqueue('{}') },
    cancel() { cancellations++ },
  })
  const wire = new OpenCodeV2ExecutionFetch('http://127.0.0.1:1', '2.0.21', '/TEST', 'TEST',
    { deadline: Date.now() + 1000 }, async (_input, init) => {
      requests++; signal = init?.signal ?? undefined
      return new Response(body, { headers: { 'content-type': 'application/json' } })
    })
  try {
    const failure = await wire.fetch('http://127.0.0.1:1/api/session/ses_original/prompt', {
      method: 'POST', body: JSON.stringify({ id: 'msg_original', text: 'one input', delivery: 'queue', resume: false }),
    }).catch(error => error)
    expect(failure).toBeInstanceOf(ExecutionTransportFailure)
    expect(failure).toMatchObject({ code: 'invalid_response', disposition: 'unknown' })
    expect(executionWasNotSubmitted(failure)).toBe(false)
    expect(requests).toBe(1)
    expect(signal?.aborted).toBe(true)
    expect(cancellations).toBe(1)
    expect(body.locked).toBe(false)
  } finally { await wire.dispose() }
})

// Neither a 404 status nor a public error-shaped object proves absence. Only a
// completely consumed, validated native error for this exact GET can do so.
for (const pin of ['2.0.0', '2.0.21'] as const) test(`session absence requires complete exact native 404 for ${pin}`, async () => {
  const native = { _tag: 'SessionNotFoundError', sessionID: 'ses_original', message: 'private native detail' }
  const json = JSON.stringify(native)
  const cases = [
    { name: 'valid', body: json, missing: true },
    { name: 'foreign ID', body: JSON.stringify({ ...native, sessionID: 'ses_foreign' }) },
    { name: 'foreign tag', body: JSON.stringify({ ...native, _tag: 'MessageNotFoundError' }) },
    { name: 'extra field', body: JSON.stringify({ ...native, extra: true }) },
    { name: 'missing message', body: JSON.stringify({ _tag: native._tag, sessionID: native.sessionID }) },
    { name: 'oversized message', body: JSON.stringify({ ...native, message: 'x'.repeat(4097) }) },
    { name: 'truncated JSON', body: json.slice(0, -1) },
    { name: 'wrong media', body: json, media: 'text/html' },
    { name: 'wrong status', body: json, status: 500 },
    { name: 'other read route', body: json, route: '/api/session/ses_original/inbox' },
    { name: 'body read failure', body: json, broken: true },
  ]
  for (const scenario of cases) {
    let calls = 0
    const wire = new OpenCodeV2ExecutionFetch('http://127.0.0.1:1', pin, '/TEST', 'TEST',
      { deadline: Date.now() + 1000 }, async () => {
        calls++
        const body = scenario.broken ? new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode(scenario.body)) },
          pull(controller) { controller.error(new Error('body lost')) },
        }) : scenario.body
        return new Response(body, { status: scenario.status ?? 404,
          headers: { 'content-type': scenario.media ?? 'application/json' } })
      })
    try {
      let failure: unknown
      try { await wire.fetch(`http://127.0.0.1:1${scenario.route ?? '/api/session/ses_original'}`) }
      catch (error) { failure = error }
      expect(failure).toBeInstanceOf(ExecutionTransportFailure)
      expect(failure).toMatchObject({ disposition: 'unknown' })
      expect(calls).toBe(1)
      expect(executionWasNotSubmitted(failure)).toBe(false)
      expect(executionSessionIsMissing(failure, 'ses_original')).toBe(scenario.missing === true)
      expect(executionSessionIsMissing(failure, 'ses_foreign')).toBe(false)
      const wrapped = Object.assign(new Error('Transport', { cause: failure }), { name: 'ClientError', reason: 'Transport' })
      expect(executionSessionIsMissing(wrapped, 'ses_original')).toBe(scenario.missing === true)
      if (failure instanceof Error) expect(failure.message).not.toContain(native.message)
    } finally { await wire.dispose() }
  }
  expect(executionSessionIsMissing(native, 'ses_original')).toBe(false)
  expect(executionSessionIsMissing(new ExecutionTransportFailure('session_missing', 'unknown'), 'ses_original')).toBe(false)
})

for (const pin of ['2.0.0', '2.0.21'] as const) test(`${pin} selected config readback cannot widen filesystem or mutation authority`, async () => {
  let invoked = 0
  const wire = new OpenCodeV2ExecutionFetch('http://127.0.0.1:1', pin, '/TEST/project', 'TEST',
    { deadline: Date.now() + 1000 }, async () => { invoked++; return Response.json([]) })
  try {
    const config = 'http://127.0.0.1:1/api/config?location%5Bdirectory%5D=%2FTEST%2Fproject'
    expect(await (await wire.fetch(config)).json()).toEqual([])
    for (const url of [config.replace('%2FTEST%2Fproject', '%2Fforeign'), config + '&path=%2Fetc',
      'http://127.0.0.1:1/api/config', config.replace('/api/config', '/api/config/providers')]) {
      const failure = await wire.fetch(url).catch(error => error)
      expect(executionWasNotSubmitted(failure)).toBe(true)
    }
    const mutation = await wire.fetch(config, { method: 'POST', body: '{}' }).catch(error => error)
    expect(executionWasNotSubmitted(mutation)).toBe(true)
    expect(invoked).toBe(1)
  } finally { await wire.dispose() }
})
