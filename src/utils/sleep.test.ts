import assert from 'node:assert/strict'
import { execFile, type ExecFileException } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

const helperUrl = new URL('./sleep.ts', import.meta.url).href
type Contract = 'default' | 'timeout' | 'resolved' | 'rejected' | 'retained'
type ChildResult = {
  error: ExecFileException | undefined
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

async function runIdleContract(contract: Contract) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-timeout-idle-'))
  try {
    const fixture = join(root, 'idle-contract.mts')
    const ready = join(root, 'ready')
    await writeFile(fixture, `
import { writeFileSync } from 'node:fs'
import { withTimeout } from ${JSON.stringify(helperUrl)}

const contract = ${JSON.stringify(contract)}
const operation = contract === 'resolved'
  ? Promise.resolve('TEST-value')
  : contract === 'rejected'
    ? Promise.reject(new Error('TEST-rejection'))
    : new Promise<string>(() => {})

// Do not await at module scope or force exit: the helper owns process liveness.
void withTimeout(operation, contract === 'timeout' ? 50 : 60_000,
  'TEST-timeout', contract === 'default' ? undefined : { keepAlive: true }).then(
  (value: string) => {
    if (contract !== 'resolved' || value !== 'TEST-value') throw new Error('Unexpected resolution')
    process.stdout.write('resolved\\n')
  },
  (error: unknown) => {
    const expected = contract === 'rejected' ? 'TEST-rejection' : 'TEST-timeout'
    if (!(error instanceof Error) || error.message !== expected) throw new Error('Unexpected rejection')
    process.stdout.write(contract === 'rejected' ? 'rejected\\n' : 'timed-out\\n')
  },
)
// Synchronous evidence of timer registration adds no live I/O handle.
writeFileSync(${JSON.stringify(ready)}, contract)
`)
    const args = process.versions.bun
      ? ['--no-install', '--no-env-file', fixture]
      : [fixture]
    const started = performance.now()
    let closed: Promise<void> | undefined
    // Bun 1.3.11's Windows spawnSync timeout uses a stale isolated-loop clock
    // after earlier synchronous shell discovery (oven-sh/bun#33935).
    const result = await new Promise<ChildResult>((resolve) => {
      const child = execFile(process.execPath, args, {
        cwd: root,
        env: {
          PATH: '',
          HOME: root,
          USERPROFILE: root,
          APPDATA: join(root, 'appdata'),
          LOCALAPPDATA: join(root, 'local-appdata'),
          XDG_CONFIG_HOME: join(root, '.config'),
          XDG_DATA_HOME: join(root, '.local', 'share'),
          XDG_CACHE_HOME: join(root, '.cache'),
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          NODE_ENV: 'test',
          CI: '1',
        },
        encoding: 'utf8',
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      }, (error, stdout, stderr) => resolve({
        error: error ?? undefined,
        status: child.exitCode,
        signal: child.signalCode,
        stdout,
        stderr,
      }))
      closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    })
    await closed
    const elapsedMs = performance.now() - started
    const registered = await readFile(ready, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    return { ...result, elapsedMs, registered: registered === contract }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('withTimeout idle process contract', () => {
  for (const { contract, stdout } of [
    { contract: 'default', stdout: '' },
    { contract: 'timeout', stdout: 'timed-out\n' },
    { contract: 'resolved', stdout: 'resolved\n' },
    { contract: 'rejected', stdout: 'rejected\n' },
  ] as const) {
    test(contract, { timeout: 10_000 }, async () => {
      const result = await runIdleContract(contract)
      const diagnostic = `${contract}: registered=${result.registered}, elapsed=${result.elapsedMs.toFixed(1)}ms`
      assert.equal(result.error, undefined, `${diagnostic}: ${result.error?.message ?? ''}`)
      assert.equal(result.registered, true, diagnostic)
      assert.equal(result.signal, null, diagnostic)
      assert.equal(result.status, 0, `${diagnostic}: ${result.stderr}`)
      assert.equal(result.stderr, '', diagnostic)
      assert.equal(result.stdout, stdout, diagnostic)
    })
  }

  test('a retained 60-second timer fails the same idle deadline after registration', { timeout: 10_000 }, async () => {
    const result = await runIdleContract('retained')
    const diagnostic = `retained: registered=${result.registered}, elapsed=${result.elapsedMs.toFixed(1)}ms`
    assert.equal(result.registered, true, diagnostic)
    assert.equal(result.error?.killed, true, diagnostic)
    assert.equal(result.signal, 'SIGKILL', diagnostic)
    assert.equal(result.status, null, diagnostic)
    assert.equal(result.stdout, '', diagnostic)
    assert.equal(result.stderr, '', diagnostic)
    assert(result.elapsedMs >= 4_000 && result.elapsedMs < 10_000, diagnostic)
  })
})
