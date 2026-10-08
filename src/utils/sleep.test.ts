import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

const helperUrl = new URL('./sleep.ts', import.meta.url).href
type Contract = 'default' | 'timeout' | 'resolved' | 'rejected'

async function runIdleContract(contract: Contract) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-timeout-idle-'))
  try {
    const fixture = join(root, 'idle-contract.mts')
    await writeFile(fixture, `
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
`)
    const args = process.versions.bun
      ? ['--no-install', '--no-env-file', fixture]
      : [fixture]
    return spawnSync(process.execPath, args, {
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
    })
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
      assert.equal(result.error, undefined, result.error?.message)
      assert.equal(result.signal, null)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, '')
      assert.equal(result.stdout, stdout)
    })
  }
})
