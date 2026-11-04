import { expect, test } from 'bun:test'
import { withOpenCodeRegistryLockDiagnostics as withLock } from './OpenCodeRegistryLockDiagnostics.js'

function fixture(enabled = true) {
  const lines: string[] = []
  let time = 0
  return { lines, advance: (ms: number) => { time += ms }, ports: {
    enabled, now: () => time, selfBirth: async () => 1234,
    lockAge: async () => 8200, write: (line: string) => { lines.push(line) },
  } }
}

test('registry diagnostics await the original release and separate wait from hold time', async () => {
  const f = fixture()
  let unblock!: () => void
  let releasing!: () => void
  const releaseStarted = new Promise<void>(resolve => { releasing = resolve })
  const gate = new Promise<void>(resolve => { unblock = resolve })
  let settled = false
  const result = withLock('ensure_read', '/TEST/private-registry', async () => {
    f.advance(10)
    return async () => { releasing(); await gate; f.advance(5) }
  }, async () => { f.advance(20); return 'result' }, f.ports).then(value => { settled = true; return value })
  await releaseStarted
  expect(settled).toBe(false)
  unblock()
  expect(await result).toBe('result')
  const rows = f.lines.map(line => JSON.parse(line.slice('[opencode-registry-lock] '.length)))
  expect(rows.map(row => row.phase)).toEqual(['waiting', 'acquired', 'releasing', 'released'])
  expect(rows.at(-1)).toMatchObject({ operation: 'ensure_read', stage: 'release',
    pid: process.pid, processStartedAtMs: 1234, waitMs: 10, heldMs: 25 })
  expect(new Set(rows.map(row => row.lockAttemptId)).size).toBe(1)
  expect(f.lines.join('')).not.toContain('/TEST/private-registry')
})

test.each(['acquire', 'callback', 'release'] as const)('registry %s failure preserves identity and cleanup', async stage => {
  const f = fixture()
  const error = Object.assign(new Error('secret-payload'), { code: 'ELOCKED', token: 'secret-payload' })
  let callbacks = 0, releases = 0
  const result = withLock('dispose_host', '/TEST/private-registry', async () => {
    if (stage === 'acquire') throw error
    return async () => { releases++; if (stage === 'release') throw error }
  }, async () => { callbacks++; if (stage === 'callback') throw error }, f.ports)
  try { await result; throw new Error('expected rejection') } catch (caught) { expect(caught).toBe(error) }
  expect(callbacks).toBe(stage === 'acquire' ? 0 : 1)
  expect(releases).toBe(stage === 'acquire' ? 0 : 1)
  const rows = f.lines.map(line => JSON.parse(line.slice('[opencode-registry-lock] '.length)))
  expect(rows.find(row => row.phase === 'failed')).toMatchObject({ stage, errorCode: 'ELOCKED',
    lockMtimeAgeMs: stage === 'acquire' ? 8200 : null })
  expect(f.lines.join('')).not.toContain('secret-payload')
})

test('disabled or broken diagnostics never replace the lock outcome or emit payload', async () => {
  const original = new Error('secret-payload')
  for (const enabled of [false, true]) {
    let releases = 0, writes = 0, birthReads = 0
    const result = withLock('ensure_read', '/TEST/private-registry', async () => async () => { releases++ },
      async () => { throw original }, {
        enabled, now: () => 0,
        selfBirth: async () => { birthReads++; return null },
        lockAge: async () => { throw new Error('unexpected mtime read') },
        write: () => { writes++; throw new Error('broken sink') },
      })
    try { await result } catch (caught) { expect(caught).toBe(original) }
    expect(releases).toBe(1)
    expect(writes > 0).toBe(enabled)
    expect(birthReads).toBe(enabled ? 1 : 0)
  }
  const releaseError = new Error('release wins')
  await expect(withLock('ensure_read', '', async () => async () => { throw releaseError },
    async () => { throw original }, fixture(false).ports)).rejects.toBe(releaseError)
})
