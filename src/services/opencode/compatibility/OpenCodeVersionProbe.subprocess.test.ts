import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { killProcessTreeAndWait, readProcessStartTimeMs } from '../../../utils/processKill.js'
import { privateOpenCodeReadEnvironment } from '../profile/OpenCodeV2ManagedConfig.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'

const fixture = fileURLToPath(new URL('./OpenCodeVersionProbe.subprocess.fixture.ts', import.meta.url))
type Evidence = { pid: number; birth: number; root: string }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function evidence(file: string): Evidence {
  const row: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!row || typeof row !== 'object' || !('pid' in row) || !('birth' in row) || !('root' in row) ||
    typeof row.pid !== 'number' || typeof row.birth !== 'number' || typeof row.root !== 'string') {
    throw new Error('Invalid TEST process evidence')
  }
  return { pid: row.pid, birth: row.birth, root: row.root }
}

async function physicallyRetired(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null)
    // An unreaped zombie has exited and cannot execute or retain a pipe.
    return stat === null || stat.slice(stat.lastIndexOf(')') + 1).trim().startsWith('Z ')
  }
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

async function runBounded(mode: 'inspect' | 'abort', marker: string, executable: string, root: string) {
  const child = spawn(process.execPath, [fixture, mode, marker, executable], {
    cwd: root, env: privateOpenCodeReadEnvironment(root), stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = '', expired = false
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const timeout = setTimeout(() => { expired = true; child.kill('SIGKILL') }, 12_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve)
    })
    expect(expired).toBe(false)
    expect(code).toBe(0)
    expect(stderr).toBe('')
    const result: unknown = JSON.parse(stdout.trim())
    if (!result || typeof result !== 'object') throw new Error('Invalid subprocess report')
    return result
  } finally { clearTimeout(timeout) }
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-opencode-version-lifecycle-'))
  await Promise.all(['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata']
    .map(dir => mkdir(path.join(root, dir))))
  const marker = path.join(root, 'owned.json')
  const executable = path.join(root, process.platform === 'win32' ? 'opencode.cmd' : 'opencode')
  if (process.platform === 'win32') {
    await writeFile(executable, `@echo off\r\n"${process.execPath}" "${fixture}" leader "${marker}"\r\n`)
  } else {
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} leader ${quote(marker)}\n`)
    await chmod(executable, 0o700)
  }
  return { root, marker, executable }
}

async function cleanupRecorded(file: string) {
  if (!existsSync(file)) return
  const row = evidence(file)
  if (!await physicallyRetired(row.pid) && await readProcessStartTimeMs(row.pid) === row.birth) {
    await killProcessTreeAndWait(row.pid, 'SIGKILL', { expectedStartedAtMs: row.birth, timeoutMs: 2000 })
  }
}

// The old direct-child kill leaves the heartbeat/stdout holder alive and reports
// identity unavailable; the subprocess deadline alone cannot satisfy these checks.
test('version admission physically retires its stdout holder before returning and leaves a foreign process alive', async () => {
  const { root, marker, executable } = await setup()
  const foreignMarker = path.join(root, 'foreign.json')
  const foreign = spawn(process.execPath, [fixture, 'foreign', foreignMarker], {
    cwd: root, env: privateOpenCodeReadEnvironment(root), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const foreignClosed = new Promise<void>(resolve => { foreign.once('close', () => resolve()) })
  let qualified = false
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      readyTimer = setTimeout(() => reject(new Error('Foreign TEST fixture readiness expired')), 5000)
      foreign.once('message', () => { clearTimeout(readyTimer); resolve() })
      foreign.once('error', reject)
      foreign.once('close', () => reject(new Error('Foreign TEST fixture exited')))
    })
    const report = await runBounded('inspect', marker, executable, root)
    expect('error' in report).toBe(false)
    expect('acquiring' in report && report.acquiring).toBe(true)
    expect('result' in report && report.result).toMatchObject({ policy: { generation: 'v1', version: '1.18.34' } })
    const owned = evidence(marker), leader = evidence(marker + '.leader'), unrelated = evidence(foreignMarker)
    expect(await physicallyRetired(leader.pid)).toBe(true)
    expect(await physicallyRetired(owned.pid)).toBe(true)
    expect(existsSync(owned.root)).toBe(false)
    expect(await physicallyRetired(unrelated.pid)).toBe(false)
    const heartbeat = readFileSync(marker + '.heartbeat', 'utf8')
    await pause(150)
    expect(readFileSync(marker + '.heartbeat', 'utf8')).toBe(heartbeat)
    expect(readFileSync(foreignMarker + '.heartbeat', 'utf8').length).toBeGreaterThan(0)
    qualified = true
  } finally {
    clearTimeout(readyTimer)
    foreign.kill('SIGTERM')
    await cleanupRecorded(foreignMarker)
    await cleanupRecorded(marker)
    await cleanupRecorded(marker + '.leader')
    // Join the explicitly owned sentinel too. Failure roots stay with the outer
    // namespace verifier; a killed worker or cleanup timeout earns no deletion.
    await boundOpenCodeRead(foreignClosed, 3000)
    if (qualified) await rm(root, { recursive: true, force: true })
  }
}, 25_000)

test('abort during executable acquisition leaves the selected wrapper body unstarted', async () => {
  const { root, marker, executable } = await setup()
  let qualified = false
  try {
    const report = await runBounded('abort', marker, executable, root)
    expect('error' in report).toBe(true)
    expect('acquiring' in report && report.acquiring).toBe(true)
    expect('markerExists' in report && report.markerExists).toBe(false)
    await pause(150)
    expect(existsSync(marker + '.leader')).toBe(false)
    expect(existsSync(marker)).toBe(false)
    qualified = true
  } finally {
    await cleanupRecorded(marker)
    await cleanupRecorded(marker + '.leader')
    if (qualified) await rm(root, { recursive: true, force: true })
  }
}, 20_000)
