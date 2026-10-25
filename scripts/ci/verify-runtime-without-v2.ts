// Checks a runtime packaged with RUNTIME_OPENCODE_V2=off: only the compiled front door, which
// runs `runtime` commands itself, and a release contract that qualifies no V2 version.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openCodeV2ReleaseDelivery, releaseOpenCodeV2Contract } from '../opencode-v2/release-delivery.js'

const fail = (message: string): never => { throw new Error(`runtime without V2: ${message}`) }
if (openCodeV2ReleaseDelivery() !== 'off') fail('RUNTIME_OPENCODE_V2=off is required')
const binary = process.env.CANDIDATE_BINARY ?? fail('CANDIDATE_BINARY is required')
for (const leftover of ['dist/opencode-delivery.json', 'dist/local-cli', 'dist/bun'])
  if (existsSync(leftover)) fail(`V2 delivery present: ${leftover}`)
if (!existsSync('dist/cursor-managed')) fail('managed Cursor assets missing')

const contract = releaseOpenCodeV2Contract()
if (Object.values(contract.qualified).some(versions => versions.length > 0)) fail('a V2 version is qualified')
if (Object.keys(contract.qualified).length === 0) fail('release platforms missing from the contract')

const run = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(binary, args, { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
const version = run(['--version'], process.env)
if (version.status !== 0 || version.stdout.trim() !== '2.777.777 (Claude Code)') fail(`--version: ${version.stdout}${version.stderr}`)

// The compiled runtime answers `runtime status` itself, in an empty profile without OpenCode on PATH.
const home = mkdtempSync(path.join(tmpdir(), 'TEST-runtime-without-v2-'))
try {
  const status = run(['runtime', 'status', '--provider', 'opencode', '--json'], {
    PATH: '', HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'local-appdata'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  })
  if (status.status !== 0) fail(`runtime status exited ${status.status}: ${status.stderr.slice(-2000)}`)
  const payload = JSON.parse(status.stdout) as { schemaVersion?: unknown; providers?: Record<string, unknown> }
  if (payload.schemaVersion !== 2 || !payload.providers || !('opencode' in payload.providers)) fail('unexpected runtime status payload')
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log('Runtime without OpenCode V2: compiled front door only, runtime status served in process, no V2 version qualified')
