import { expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  drainStartupTaskkills,
  hasPendingStartupTaskkill,
  isProcessAlive,
  killProcessTreeForStartup,
  readProcessStartTimeMs,
} from '../../utils/processKill.js'
import { OpenCodeStartupCleanupBudget } from './OpenCodeStartupCleanupBudget.js'

// Run this file on Windows without platform overrides or process/identity mocks.
// A single leaf is intentional: this proves native taskkill and admission/drain,
// not descendant enumeration or the synthetic delayed-helper-close scenario.
const nativeTest = process.platform === 'win32' ? test : test.skip
const QUERY_MS = 6_000
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type Owned = {
  name: string
  child: ChildProcess
  closed: Promise<void>
  didClose: boolean
  birth: number | null
}

nativeTest('native startup taskkill drains, preserves other births and refuses wrong birth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-startup-native-'))
  const owned: Owned[] = []
  const manifest = join(directory, 'owned-processes.json')
  const saveManifest = () => writeFile(manifest, JSON.stringify({
    schemaVersion: 1,
    processes: owned.map(({ name, child, birth }) => ({ name, pid: child.pid, birth })),
  }, null, 2))

  async function start(name: string): Promise<Owned> {
    const profile = join(directory, name)
    await mkdir(profile)
    const child = spawn(process.execPath, [join(directory, 'fixture.cjs')], {
      cwd: profile,
      env: { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: profile,
        LOCALAPPDATA: profile, TEMP: profile, TMP: profile },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    // Track before any await; even readiness/identity/manifest failure owns cleanup.
    const entry: Owned = { name, child, birth: null, didClose: false, closed: Promise.resolve() }
    owned.push(entry)
    entry.closed = new Promise(resolve => child.once('close', () => {
      entry.didClose = true
      resolve()
    }))
    // These listeners also cover errors after the readiness promise settles.
    child.stdin!.on('error', () => {})
    await bounded(new Promise<void>((resolve, reject) => {
      let output = ''
      child.on('error', reject)
      child.once('close', () => reject(new Error(`${name} closed before ready`)))
      child.stdout!.on('data', chunk => {
        output = (output + chunk.toString()).slice(-256)
        if (output.includes(`READY ${child.pid}\n`)) resolve()
      })
    }), 10_000, `${name} readiness`)
    entry.birth = await readProcessStartTimeMs(child.pid!, 'win32', QUERY_MS)
    expect(entry.birth).not.toBeNull()
    expect(Number.isFinite(entry.birth)).toBe(true)
    expect(entry.didClose).toBe(false)
    await saveManifest()
    return entry
  }

  async function stillSame(entry: Owned) {
    expect(entry.didClose).toBe(false)
    expect(isProcessAlive(entry.child.pid!)).toBe(true)
    expect(await readProcessStartTimeMs(entry.child.pid!, 'win32', QUERY_MS)).toBe(entry.birth)
  }

  try {
    // No engine, auth, network or grandchildren. EOF handles incomplete setup;
    // the watchdog also bounds lifetime if the test runner itself disappears.
    await writeFile(join(directory, 'fixture.cjs'), `
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
setTimeout(() => process.exit(0), 90000);
process.stdout.write('READY ' + process.pid + '\\n');
`)
    const sentinel = await start('sentinel')
    const target = await start('target')
    const result = await bounded(killProcessTreeForStartup(target.child.pid!, target.birth!,
      new OpenCodeStartupCleanupBudget(Date.now() + 30_000)), 20_000, 'native termination')
    await bounded(drainStartupTaskkills(), 10_000, 'startup drain')
    expect(result).toEqual({ helperTerminated: true, rootGone: true, treeKillSucceeded: true })
    expect(hasPendingStartupTaskkill(target.child.pid!)).toBe(false)
    await bounded(target.closed, 5_000, 'target close')
    expect(isProcessAlive(target.child.pid!)).toBe(false)
    await stillSame(sentinel)

    const fresh = await start('after-drain')
    const refused = await bounded(killProcessTreeForStartup(sentinel.child.pid!, sentinel.birth! + 60_000,
      new OpenCodeStartupCleanupBudget(Date.now() + 30_000)), 20_000, 'wrong-birth refusal')
    await bounded(drainStartupTaskkills(), 10_000, 'refusal drain')
    expect(refused).toEqual({ helperTerminated: true, rootGone: false, treeKillSucceeded: false })
    expect(hasPendingStartupTaskkill(sentinel.child.pid!)).toBe(false)
    // Observe beyond the helper's 2.5s timeout plus 1s observation window.
    await pause(4_000)
    await stillSame(sentinel)
    await stillSame(fresh)
  } finally {
    // Cooperative EOF works even when setup failed before a birth was captured.
    // Never signal an unverified PID, enumerate processes, or invoke broad cleanup.
    const cleanup = await Promise.allSettled(owned.map(async entry => {
      if (entry.didClose) return
      entry.child.stdin?.end()
      try {
        await bounded(entry.closed, 3_000, `${entry.name} EOF cleanup`)
      } catch {
        try {
          if (!entry.didClose && entry.birth !== null
            && await readProcessStartTimeMs(entry.child.pid!, 'win32', QUERY_MS) === entry.birth
            && !entry.didClose) {
            entry.child.kill('SIGKILL')
          }
        } finally {
          // Even a failed signal must wait for the owned fixture to exit.
          // Unknown birth: rely only on the owned pipe and fixture watchdog.
          await bounded(entry.closed, 95_000, `${entry.name} watchdog cleanup`)
        }
      }
    }))
    const failures = cleanup.filter(result => result.status === 'rejected')
    if (failures.length) throw new Error(`Owned fixture cleanup failed; manifest retained at ${manifest}`)
    await rm(directory, { recursive: true, force: true })
  }
}, 240_000)
