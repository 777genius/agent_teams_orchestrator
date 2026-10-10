import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../entrypoints/cli.tsx', import.meta.url))
const bun = process.versions.bun ? process.execPath : process.env.TEST_RUNTIME_STATUS_BUN ?? 'bun'

async function runStatus(flags: readonly string[]) {
  const home = await mkdtemp(join(tmpdir(), 'TEST-runtime-status-entry-'))
  const child = spawn(bun, ['--no-install', '--no-env-file', entry, 'runtime', 'status', ...flags], {
    cwd: home,
    env: { PATH: '', HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'local-appdata'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), NODE_ENV: 'development', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (signal) reject(new Error(`Source CLI terminated by ${signal}`))
        else resolve(code)
      })
    })
    return { stdout, stderr, code }
  } finally {
    clearTimeout(timer)
    await rm(home, { recursive: true, force: true })
  }
}

describe('source runtime status without unrelated provider authentication', () => {
  for (const { flags, provider } of [
    { flags: ['--provider', 'opencode', '--json'], provider: 'opencode' },
    { flags: ['--provider=opencode', '--summary'], provider: 'opencode' },
    { flags: ['--provider', 'gemini', '--summary'], provider: 'gemini' },
  ]) {
    test(`returns genuine filtered inventory with ${flags.join(' ')}`, { timeout: 25_000 }, async () => {
      const result = await runStatus(flags)
      assert.equal(result.code, 0)
      const payload: unknown = JSON.parse(result.stdout)
      assert(typeof payload === 'object' && payload !== null && 'schemaVersion' in payload && 'providers' in payload)
      assert.equal(payload.schemaVersion, 2)
      assert(typeof payload.providers === 'object' && payload.providers !== null)
      assert.deepEqual(Object.keys(payload.providers), [provider])
      const status: unknown = Reflect.get(payload.providers, provider)
      assert(typeof status === 'object' && status !== null && 'providerId' in status && 'authenticated' in status)
      assert.equal(status.providerId, provider)
      assert.equal(status.authenticated, false)
    })
  }

  for (const flags of [['--provider', 'invalid'], ['--provider'], ['--unknown'], ['unexpected']]) {
    test(`rejects malformed status arguments ${flags.join(' ')}`, { timeout: 25_000 }, async () => {
      const result = await runStatus(flags)
      assert.notEqual(result.code, 0)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /error:/)
    })
  }

  test('help does not initialize an unrelated provider', { timeout: 25_000 }, async () => {
    const result = await runStatus(['--help'])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /--provider/)
    assert.match(result.stdout, /--summary/)
  })
})
