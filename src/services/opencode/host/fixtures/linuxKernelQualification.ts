// Sole producer execution exception: fresh owned synthetic Bun IPC/PID fixture.
// Run with the pinned Bun, including ordinary-user controllers. No official server/provider/build imports.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { linuxBirth, linuxFileHash, linuxLauncherVersion, planLinuxExecution, launchLinuxExecution,
  readLinuxProcessIdentity, isKernelRetirement, linuxPidfdHasExited, type LinuxExecutionLaunch } from '../OpenCodeV2ExecutionLauncher.js'

const PINNED_BUN_SHA256 = '6d5bb405b1d037a2a466b92757de7e47e4369930fa94bd42f8ff44ba49de6c57'
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const base = process.argv[2]
assert(base && path.isAbsolute(base) && path.basename(base).startsWith('TEST-'), 'fixture_requires_fresh_TEST_directory')
await mkdir(base, { mode: 0o700 }) // EEXIST refuses reuse, never overwrites another job.
const root = await realpath(base), startedAt = Date.now(), deadline = startedAt + 27_000
const observations: unknown[] = []
let status = 'BLOCKED', failure: string | undefined, cleanupUnknown = false
let launch: LinuxExecutionLaunch | undefined
let sentinel: ReturnType<typeof spawn> | undefined, sentinelExit: Promise<void> | undefined
const sentinelStderr: Buffer[] = []
let sentinelPID: number | undefined, sentinelBirth: Awaited<ReturnType<typeof linuxBirth>> = null
let observedInitFD: number | undefined
let closeObservedInitFD: ((fd: number) => void) | undefined
const receipt = () => ({ schema: 1, status, qualification: status === 'PASS' ? 'SYNTHETIC ONLY' : 'NOT RUN/BLOCKED',
  startedAt, elapsedMs: Date.now() - startedAt, maxDurationMs: 30_000,
  controller: { executable: process.execPath, bunVersion: process.versions.bun, uid: process.getuid?.() }, failure, cleanupUnknown,
  observations, nativeTests: 'NOT RUN', broadTests: 'NOT RUN', typechecks: 'NOT RUN', buildInstall: 'NOT RUN' })
const watchdog = setTimeout(() => {
  cleanupUnknown = true; failure = 'fixture_global_deadline_cleanup_unknown'
  void writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt(), null, 2) + '\n').finally(() => process.exit(124))
}, 29_000)
async function bound<T>(work: Promise<T>, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('fixture_deadline')), Math.max(1, Math.min(milliseconds, deadline - Date.now())))
  })]) } finally { clearTimeout(timer) }
}
function nextMessage(child: ReturnType<typeof spawn>, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const message = (value: unknown) => {
      if (value && typeof value === 'object' && 'type' in value && value.type === type) {
        remove(); resolve(value as Record<string, unknown>)
      }
    }
    const closed = (code: number | null, signal: NodeJS.Signals | null) => { remove(); reject(new Error('fixture_child_closed ' + JSON.stringify({ expectedMessage: type, pid: child.pid, code, signal, spawnfile: child.spawnfile, spawnargs: child.spawnargs }))) }
    const failed = (error: Error) => { remove(); reject(new Error('fixture_child_error ' + JSON.stringify({ expectedMessage: type, pid: child.pid, name: error.name, message: error.message, code: 'code' in error ? error.code : undefined, spawnfile: child.spawnfile, spawnargs: child.spawnargs }), { cause: error })) }
    const remove = () => { child.removeListener('message', message); child.removeListener('close', closed); child.removeListener('error', failed) }
    child.on('message', message); child.once('close', closed); child.once('error', failed)
  })
}
try {
  assert(process.versions.bun === '1.3.11', 'fixture_controller_requires_pinned_Bun_1.3.11')
  const bun = { path: await realpath(process.execPath), sha256: await linuxFileHash(process.execPath) }
  assert(bun.sha256 === PINNED_BUN_SHA256, 'fixture_Bun_digest_mismatch')
  const { dlopen, FFIType } = await import('bun:ffi')
  const pidfds = dlopen('libc.so.6', {
    pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  })
  closeObservedInitFD = fd => assert(pidfds.symbols.close(fd) === 0, 'fixture_pidfd_close_failed')
  const launcherVersion = await bound(linuxLauncherVersion('/usr/bin/bwrap'), 1500)
  observations.push({ launcherVersion, launcherSha256: await linuxFileHash('/usr/bin/bwrap'), bun })
  assert(launcherVersion === 'bubblewrap 0.13.0', 'fixture_requires_pinned_bwrap_0.13.0')
  const entry = await realpath(fileURLToPath(new URL('./linuxKernelChild.ts', import.meta.url)))
  const sourceRoot = path.resolve(path.dirname(entry), '../../../../..')
  sentinel = spawn(bun.path, [entry], { env: { TMPDIR: root, R247_FIXTURE_MODE: 'sentinel' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' })
  sentinel.stderr?.on('data', (bytes: Buffer) => { sentinelStderr.push(Buffer.from(bytes)) })
  sentinelExit = new Promise<void>((resolve, reject) => { sentinel?.once('close', () => resolve()); sentinel?.once('error', reject) })
  void sentinelExit.catch(() => undefined)
  const readySentinel = await bound(nextMessage(sentinel, 'sentinel'))
  assert(typeof sentinel.pid === 'number' && readySentinel.pid === sentinel.pid, 'sentinel_pid_mismatch')
  sentinelPID = sentinel.pid; sentinelBirth = await linuxBirth(sentinelPID)
  assert(sentinelBirth && JSON.stringify(sentinelBirth) === JSON.stringify(readySentinel.birth), 'sentinel_birth_mismatch')
  const sentinelFacts = await readLinuxProcessIdentity(sentinelPID)
  observations.push({ sentinel: sentinelFacts })
  for (const mode of ['normal', 'wrong-pid', 'wrong-namespace', 'wrong-boot', 'wrong-executable', 'wrong-closed', 'stop-before-start', 'deadline-before-start']) {
    assert(deadline - Date.now() > 4000, 'fixture_insufficient_deadline_no_retry')
    const directory = await mkdtemp(path.join(root, `TEST-${mode}-`))
    const plan = await bound(planLinuxExecution({ bun, entry, cwd: directory, writableRoots: [directory],
      readOnlyRoots: [sourceRoot, path.dirname(bun.path)], env: { TMPDIR: directory, R247_FIXTURE_MODE: mode } }))
    const nonce = randomUUID(), leaseOwnerId = randomUUID()
    launch = launchLinuxExecution(plan, nonce, leaseOwnerId, bun)
    const active = launch
    let startMessages = 0
    active.child.on('message', value => { if (value && typeof value === 'object' && 'type' in value && value.type === 'ready') startMessages++ })
    const supervisorPID = active.child.pid
    assert(typeof supervisorPID === 'number' && supervisorPID > 0, 'fixture_supervisor_pid_missing')
    const supervisorBirth = await linuxBirth(supervisorPID)
    assert(supervisorBirth, 'fixture_supervisor_birth_missing')
    if (mode.startsWith('wrong-') && mode !== 'wrong-closed') {
      let refused = false
      try { await bound(active.prepare(deadline), 3000) } catch { refused = true }
      assert(refused && startMessages === 0, 'forged_prepare_qualified_or_started')
      try { await bound(active.retire(), 3000) } catch { /* No verified mapping earns no positive receipt. */ }
      await bound(active.exit)
      assert(await linuxBirth(supervisorPID) === null, 'forged_prepare_supervisor_not_reaped')
      observations.push({ mode, refusedBeforeStart: true, supervisorPID, supervisorBirth, output: active.output() })
      launch = undefined; continue
    }
    const mapping = await bound(active.prepare(deadline), 3000)
    assert(mapping.supervisor.hostPID === supervisorPID && mapping.bun.hostPID !== supervisorPID &&
      mapping.bun.nativePID === 1 && mapping.namespace.name !== sentinelFacts.namespace && mapping.namespace.inode.length > 0,
      'fixture_PID_namespace_mapping')
    let offspring: Awaited<ReturnType<typeof readLinuxProcessIdentity>> | undefined
    if (mode === 'normal') {
      observedInitFD = pidfds.symbols.pidfd_open(mapping.init.hostPID, 0)
      assert(observedInitFD >= 0 && !await linuxPidfdHasExited(observedInitFD), 'fixture_live_init_reported_retired')
      const local = JSON.parse(await readFile(path.join(directory, 'orphan.json'), 'utf8')) as Record<string, unknown>
      const taskDirs = await readdir(`/proc/${mapping.init.hostPID}/task`)
      for (const task of taskDirs) {
        const children = await readFile(`/proc/${mapping.init.hostPID}/task/${task}/children`, 'utf8')
        for (const token of children.trim().split(/\s+/).filter(Boolean)) {
          const actual = await readLinuxProcessIdentity(Number(token))
          if (actual.nativePID === local.pid && actual.namespace === mapping.namespace.name &&
            JSON.stringify(actual.birth) === JSON.stringify(local.birth)) offspring = actual
        }
      }
      assert(offspring, 'fixture_early_doublefork_host_mapping_missing')
      observations.push({ mode, mapping, preStartStatus: await readFile(`/proc/${mapping.bun.hostPID}/status`, 'utf8'), earlyDoublefork: offspring, survivedWorkloadProcessGroupCleanup: true, liveInitPidfdNotReady: true })
    }
    if (mode === 'stop-before-start' || mode === 'deadline-before-start') {
      if (mode === 'stop-before-start') active.sendClose()
      let refused = false
      try { await active.start({}, mode === 'deadline-before-start' ? Date.now() - 1 : deadline) } catch { refused = true }
      assert(refused && startMessages === 0, 'fixture_late_start_executed')
      if (mode === 'deadline-before-start') active.sendClose()
    } else {
      const ready = nextMessage(active.child, 'ready')
      void ready.catch(() => undefined)
      await bound(active.start({}, deadline))
      const message = await bound(ready)
      assert(message.nonce === nonce && message.leaseOwnerId === leaseOwnerId && message.namespace === mapping.namespace.name &&
        message.pid === mapping.bun.nativePID && JSON.stringify(message.birth) === JSON.stringify(mapping.bun.birth), 'fixture_private_ready_unbound')
      active.sendClose()
    }
    await bound(active.exit)
    const retirement = await bound(active.retire())
    assert(isKernelRetirement(retirement) && retirement.scopeClosed === (mode !== 'wrong-closed'), 'fixture_closed_ack_qualification')
    assert(await linuxBirth(mapping.bun.hostPID) === null && await linuxBirth(supervisorPID) === null, 'fixture_Bun_supervisor_survived')
    if (offspring) assert(await linuxBirth(offspring.hostPID) === null, 'fixture_escaped_offspring_survived_kernel_retirement')
    if (observedInitFD !== undefined) {
      assert(await linuxPidfdHasExited(observedInitFD), 'fixture_retired_init_pidfd_not_ready')
      closeObservedInitFD(observedInitFD); observedInitFD = undefined
      observations.push({ mode, retiredInitPidfdReady: true })
    }
    assert(JSON.stringify(await linuxBirth(sentinelPID)) === JSON.stringify(sentinelBirth) && sentinel.exitCode === null, 'fixture_sentinel_touched')
    await writeFile(path.join(directory, 'stdout'), active.output().stdout)
    await writeFile(path.join(directory, 'stderr'), active.output().stderr)
    observations.push({ mode, mapping, retirement, startMessages, output: active.output(), sentinelAliveAfterRetirement: true })
    launch = undefined
  }
  status = 'PASS'
} catch (error) {
  failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  status = observations.length ? 'FAIL/UNKNOWN' : 'BLOCKED'
} finally {
  if (launch) {
    try { launch.sendClose() } catch { /* Retirement still attempted. */ }
    try { await bound(launch.retire(), 3000) } catch { cleanupUnknown = true }
    await writeFile(path.join(root, 'failed-launch-output.json'), JSON.stringify(launch.output(), null, 2) + '\n')
  }
  if (sentinel && sentinelPID && sentinelBirth) {
    try {
      assert(JSON.stringify(await linuxBirth(sentinelPID)) === JSON.stringify(sentinelBirth), 'sentinel_cleanup_birth_unknown')
      sentinel.send({ type: 'close' })
      if (sentinelExit) await bound(sentinelExit)
      assert(await linuxBirth(sentinelPID) === null, 'sentinel_not_reaped')
    } catch { cleanupUnknown = true }
  } else if (sentinelExit) {
    try { await bound(sentinelExit) } catch { cleanupUnknown = true }
  }
  if (sentinelStderr.length) await writeFile(path.join(root, 'sentinel.stderr'), Buffer.concat(sentinelStderr))
  if (observedInitFD !== undefined) {
    try { assert(closeObservedInitFD, 'fixture_pidfd_close_unavailable'); closeObservedInitFD(observedInitFD) }
    catch { cleanupUnknown = true }
  }
  clearTimeout(watchdog)
  await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt(), null, 2) + '\n')
  console.log(JSON.stringify(receipt()))
  process.exit(status === 'PASS' && !cleanupUnknown ? 0 : 1)
}
