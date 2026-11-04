import { expect, test } from 'bun:test'
import { openCodeV2ExecutionCloseMs, runOpenCodeV2ExecutionCloseSequence } from './OpenCodeV2ExecutionClose.js'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const hang = () => new Promise<void>(() => undefined)

// The owner grants the wrapper 10s to exit after its close frame; a longer
// close sequence loses its ACK to the owner's force-kill path either way.
test('close sequence budget stays inside the owner wait-exit window', () => {
  expect(openCodeV2ExecutionCloseMs).toBeLessThan(10_000)
})

// The physical stop of a run holding a live command tears down far slower than
// an idle scope. A finalize that outlives its bound must not silently drop the
// closed ACK the owner needs to confirm the stop.
test('a slow finalize still earns its closed ACK', async () => {
  const events: string[] = []
  const acknowledged = await runOpenCodeV2ExecutionCloseSequence({
    finalize: async () => { events.push('finalize'); await sleep(3500); events.push('finalized') },
    acknowledge: async () => { events.push('acknowledge') },
  })
  expect(acknowledged).toBe(true)
  expect(events).toEqual(['finalize', 'finalized', 'acknowledge'])
})

// The physical stop of a run holding a live command can outlast every drain
// bound. The closed ACK certifies identity plus a disarmed facade (see the
// child-control send), so a startup join or finalize that never settles must
// never suppress it; the OS reclaims the server at process exit and the owner's
// kernel retirement proof confirms the scope independently.
test('a hung finalize or startup cannot suppress the closed ACK', async () => {
  for (const hung of [{ finalize: () => hang() }, { startup: hang() }] as const) {
    let sent = false
    const started = Date.now()
    const acknowledged = await runOpenCodeV2ExecutionCloseSequence({ ...hung, acknowledge: async () => { sent = true } },
      Date.now() + 1200)
    expect(acknowledged).toBe(true)
    expect(sent).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
  }
})

// An uncertain acknowledge -- a failed identity assert or a throwing disarm --
// still withholds the ACK exactly like an uncertain native drain would.
test('an uncertain acknowledge still withholds the closed ACK', async () => {
  for (const refused of [async () => { throw new Error('cleanup_unknown') },
    async () => { throw new Error('windows_realpath_uninstall_unknown') }] as const) {
    let sent = false
    const acknowledged = await runOpenCodeV2ExecutionCloseSequence({ acknowledge: async () => { sent = true; await refused() } })
    expect(acknowledged).toBe(false)
    expect(sent).toBe(true)
  }
})

test('a hung acknowledge cannot claim delivery', async () => {
  const acknowledged = await runOpenCodeV2ExecutionCloseSequence({ acknowledge: () => hang() }, Date.now() + 1200)
  expect(acknowledged).toBe(false)
})

test('a rejected startup join still closes an unused scope with its closed ACK', async () => {
  let sent = false
  const acknowledged = await runOpenCodeV2ExecutionCloseSequence({
    startup: Promise.reject(new Error('TEST-unused-scope')),
    acknowledge: async () => { sent = true },
  })
  expect(acknowledged).toBe(true)
  expect(sent).toBe(true)
})

test('a settled sequence delivers its closed ACK', async () => {
  let sent = false
  expect(await runOpenCodeV2ExecutionCloseSequence({ startup: Promise.resolve(), finalize: async () => {},
    acknowledge: async () => { sent = true } })).toBe(true)
  expect(sent).toBe(true)
})
