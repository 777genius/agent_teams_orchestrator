import { expect, test } from 'bun:test'
import { assertNoPtyHooks, observePty } from './packaged-pty-smoke.js'

function terminal(syntheticSignal = true) {
  let data: (value: string) => void = () => {}, exit: (value: { exitCode: number; signal?: string }) => void = () => {}
  let kills = 0
  return {
    pid: 123, onData(listener: typeof data) { data = listener; return { dispose() { data = () => {} } } },
    onExit(listener: typeof exit) { exit = listener; return { dispose() { exit = () => {} } } },
    kill() { kills++; exit({ exitCode: 0, ...(syntheticSignal ? { signal: 'SIGTERM' } : {}) }) },
    data(value: string) { data(value) }, exit(value: Parameters<typeof exit>[0]) { exit(value) },
    get kills() { return kills },
  }
}

test('PTY proof releases the retained handle only after natural zero exit and gone PID', async () => {
  const pty = terminal()
  const observation = observePty(pty, 'TEST-marker', async () => { expect(pty.kills).toBe(0); return true }, 100)
  pty.data('TEST-marker\r\n'); pty.exit({ exitCode: 0 })
  expect(await observation).toMatchObject({ ok: true, exit: { exitCode: 0 }, naturalPidGone: true,
    cleanupRequested: false, postNaturalReleaseRequested: true, postNaturalReleaseError: false })
  expect(pty.kills).toBe(1)
})

test('PTY timeout remains failed when cleanup synthesizes exit zero', async () => {
  const pty = terminal(false)
  const observation = observePty(pty, 'TEST-marker', async () => true, 1)
  pty.data('TEST-marker')
  const result = await observation
  expect(result).toMatchObject({ ok: false, timedOut: true, cleanupRequested: true,
    cleanupPidGone: true, exitObservedBeforeCleanup: false, naturalPidGone: false })
  expect(result.exit).toEqual({ exitCode: 0 })
  expect(result.output).toBe('TEST-marker')
  expect(pty.kills).toBe(1)
})

test('PTY observation refuses query errors and performs only retained-handle cleanup', async () => {
  const pty = terminal()
  const observation = observePty(pty, 'TEST-marker', async () => { throw new Error('TEST-query-unknown') }, 100)
  pty.data('TEST-marker'); pty.exit({ exitCode: 0 })
  expect(await observation).toMatchObject({ ok: false, pidQueryError: true, cleanupRequested: true })
  expect(pty.kills).toBe(1)
})

test('PTY proof refuses a missing marker, nonzero or signalled exit and surviving PID', async () => {
  for (const kind of ['missing-marker', 'nonzero', 'signal', 'survivor']) {
    const pty = terminal()
    const observation = observePty(pty, 'TEST-marker', async () => kind !== 'survivor', 100)
    if (kind !== 'missing-marker') pty.data('TEST-marker')
    pty.exit({ exitCode: kind === 'nonzero' ? 1 : 0, ...(kind === 'signal' ? { signal: 'SIGTERM' } : {}) })
    expect((await observation).ok).toBe(false)
    expect(pty.kills).toBe(1)
  }
})

test('PTY proof fails if post-natural retained-handle release throws', async () => {
  const pty = terminal()
  pty.kill = () => { throw new Error('TEST-native-release-failed') }
  const observation = observePty(pty, 'TEST-marker', async () => true, 100)
  pty.data('TEST-marker'); pty.exit({ exitCode: 0 })
  expect(await observation).toMatchObject({ ok: false, naturalPidGone: true,
    postNaturalReleaseRequested: true, postNaturalReleaseError: true })
})

test('PTY proof refuses case-insensitive loader overrides and startup hooks', () => {
  for (const key of ['BUN_PTY_LIB', 'bun_pty_lib', 'Node_Options', 'bun_preload']) {
    expect(() => assertNoPtyHooks({ [key]: '' }, [])).toThrow('override or hook')
  }
  expect(() => assertNoPtyHooks({}, ['--preload', 'foreign.ts'])).toThrow('startup arguments')
  expect(() => assertNoPtyHooks({}, ['--no-env-file'])).not.toThrow()
})
