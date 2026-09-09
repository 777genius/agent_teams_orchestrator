import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./fixtures/runtime-status-stdout.ts', import.meta.url))
const handler = fileURLToPath(new URL('./runtime.ts', import.meta.url))

async function runStatus(scenario: string, flags: string[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), 'runtime-status-stdout-'))
  const child = Bun.spawn([process.execPath, fixture, handler, scenario, ...flags], {
    cwd,
    // Never inherit credentials, provider settings, or a real project.
    env: { PATH: '', HOME: cwd, XDG_CONFIG_HOME: cwd, XDG_CACHE_HOME: cwd, NODE_ENV: 'test' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const started = performance.now()
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(child.signalCode).toBeNull()
    return { stdout, stderr, exitCode, elapsedMs: performance.now() - started }
  } finally {
    clearTimeout(watchdog)
    child.kill('SIGKILL')
    await child.exited
    await rm(cwd, { recursive: true, force: true })
  }
}

describe('runtime status subprocess stdout contract (offline)', () => {
  for (const scenario of ['reject', 'throw', 'reject-string', 'reject-delayed']) {
    test(`${scenario} reports an honest failure despite the global rejection listener`, async () => {
      const result = await runStatus(scenario)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('Runtime status failed: offline inventory failure\n')
    })
  }

  test('text status also reports a rejected inventory', async () => {
    const result = await runStatus('reject', ['--text'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Runtime status failed: offline inventory failure\n')
  })

  for (const flags of [[], ['--summary']]) {
    test(`successful ${flags.length ? 'summary' : 'full'} status preserves JSON`, async () => {
      const result = await runStatus('success', flags)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 2,
        providers: { opencode: { providerId: 'opencode', models: [], detailMessage: flags.length ? 'summary' : 'full' } },
      })
      expect(result.stdout.endsWith('\n')).toBe(true)
    })
  }

  test('runtime diagnostics stay on stderr', async () => {
    const result = await runStatus('noise')
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('inventory diagnostic\n')
    expect(JSON.parse(result.stdout).schemaVersion).toBe(2)
  })

  test('drains a large response through a pipe', async () => {
    const result = await runStatus('large')
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout).providers.opencode.models).toEqual(['x'.repeat(2 * 1024 * 1024)])
  })

  test('stdout callback failures do not become silent success', async () => {
    const result = await runStatus('write-error')
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Runtime status failed: offline stdout failure\n')
  })

  test('a writer with no callback or active handles cannot silently exit zero', async () => {
    const result = await runStatus('write-no-callback')
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Runtime status failed: Timed out writing runtime command stdout\n')
  })

  for (const [scenario, message] of [
    ['reject', 'offline inventory failure'],
    ['write-error', 'offline stdout failure'],
    ['write-no-callback', 'Timed out writing runtime command stdout'],
    ['stderr-no-callback', 'offline inventory failure'],
  ]) {
    test(`${scenario} exits nonzero even with a retained interval`, async () => {
      const result = await runStatus(scenario!, ['--retain-handle'])
      expect(result.exitCode).toBe(1)
      expect(result.elapsedMs).toBeLessThan(5_000)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`Runtime status failed: ${message}\n`)
    }, 7_000)
  }

  for (const [command, exitCode] of [
    ['verify', 0],
    ['verify-model', 0],
    ['providers-view', 0],
    ['providers-reject', 1],
    ['providers-validation', 1],
    ['opencode-command', 0],
  ] as const) {
    test(`${command} retains its bounded best-effort exit with a stalled writer and interval`, async () => {
      const result = await runStatus('write-no-callback', [`--command=${command}`, '--retain-handle'])
      expect(result.exitCode).toBe(exitCode)
      expect(result.elapsedMs).toBeGreaterThanOrEqual(2_000)
      expect(result.elapsedMs).toBeLessThan(5_000)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    }, 7_000)
  }

  for (const scenario of ['stderr-delayed', 'stderr-no-callback']) {
    test(`${scenario} drains the failure diagnostic and still exits nonzero`, async () => {
      const result = await runStatus(scenario)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('Runtime status failed: offline inventory failure\n')
    })
  }
})

// Python must own the kernel pipe: Bun.spawn eagerly consumes child streams.
// This test is explicitly part of the focused suite on Linux with Python 3.
const python = Bun.which('python3')
const pipeSkipReason = process.platform !== 'linux'
  ? 'real stalled-pipe check requires Linux'
  : !python ? 'real stalled-pipe check requires Python 3 on PATH' : null
if (pipeSkipReason) console.warn(`SKIP runtime status OS pipe regression: ${pipeSkipReason}`)
test.skipIf(pipeSkipReason !== null)('Linux OS pipe stalls fail before draining; concurrent consumption succeeds', async () => {
  const driver = fileURLToPath(new URL('./fixtures/runtime-status-stalled-pipe.py', import.meta.url))
  const cwd = await mkdtemp(join(tmpdir(), 'runtime-status-os-pipe-'))
  const child = Bun.spawn([python!, driver, process.execPath, fixture, handler], {
    cwd,
    env: { PATH: '', HOME: cwd, XDG_CONFIG_HOME: cwd, XDG_CACHE_HOME: cwd, NODE_ENV: 'test' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    const results = JSON.parse(stdout)
    expect(results.stalled.exitCode).toBe(1)
    expect(results.stalled.exitedBeforeDrain).toBe(true)
    expect(results.consumed.exitCode).toBe(0)
    expect(results.consumed.validJson).toBe(true)
  } finally {
    child.kill('SIGKILL')
    await child.exited
    await rm(cwd, { recursive: true, force: true })
  }
}, 15_000)
