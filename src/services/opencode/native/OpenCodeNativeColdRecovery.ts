import { captureColdProgress, drainColdOutput, type ColdProgress } from './OpenCodeNativeColdDiagnostics.js'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { evidence, fact, publicEpoch, readPrivateJson, type ColdInput, type ReadyReceipt } from './fixtures/OpenCodeNativeColdController.js'
import { nativeAuthorityPath, nativeExitConfirmed, readNativeAuthority } from './OpenCodeNativeAuthority.js'
import type { OpenCodePreparedProfile } from '../types.js'

async function deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('TEST_cold_observation_timeout')), milliseconds)
  })]) } finally { clearTimeout(timer) }
}

async function waitReceipt<T>(input: ColdInput, name: string): Promise<T> {
  const until = Date.now() + 10000
  while (Date.now() < until) {
    try { return await readPrivateJson<T>(path.join(input.evidence, name)) }
    catch (error) { if (!['ENOENT', 'EINPROGRESS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    await Bun.sleep(20)
  }
  throw new Error('TEST_cold_receipt_timeout')
}

/** Physical qualification only: import is inert, callers must supply a fresh
 * TEST case root and the already verified pinned vendor/helper. */
export async function qualifyNativeColdRecovery(options: {
  root: string; evidenceRoot: string; binary: string; helper: string; version: '1.16.0' | '1.18.34'; sourceSha: string
  parentSignal: AbortSignal
}): Promise<{ retiredImageRoot: string }> {
  fact(process.platform === 'linux' && /^[a-f0-9]{40}$/.test(options.sourceSha))
  const caseId = `TEST-cold-${randomBytes(8).toString('hex')}`
  const work = path.join(options.root, caseId), output = path.join(options.evidenceRoot, caseId)
  await mkdir(work, { mode: 0o700 }); await mkdir(output, { mode: 0o700 })
  const dataRoot = path.join(work, 'data'), project = path.join(work, 'TEST-project')
  const profileRoot = path.join(dataRoot, 'opencode', 'profiles', '0123456789abcdef')
  await mkdir(project, { mode: 0o700 }); await mkdir(profileRoot, { recursive: true, mode: 0o700 })
  const marker = `Bearer TEST-cold-${caseId}`
  const config = { mcp: { fixture: { type: 'remote', url: 'http://127.0.0.1:1/mcp', enabled: false,
    headers: { Authorization: marker } } } }
  const profile: OpenCodePreparedProfile = {
    projectPath: project, canonicalProjectPath: project, workingDirectoryPath: project, scopeToken: null,
    profileRootKey: '0123456789abcdef', profileRootPath: profileRoot,
    projectBehaviorFingerprint: 'TEST-cold-profile', behaviorSources: [], managedConfig: config,
    managedConfigFingerprint: `TEST-cold-${options.version}`, homePath: path.join(profileRoot, 'home'),
    tmpPath: path.join(profileRoot, 'tmp'), xdgConfigHome: path.join(profileRoot, 'config'),
    xdgDataHome: path.join(profileRoot, 'data'), xdgCacheHome: path.join(profileRoot, 'cache'),
    managedAuthPath: path.join(profileRoot, 'auth.json'), sourceAuthPath: null,
    sourceAuthFingerprint: null, managedAuthFingerprint: null, authState: 'missing',
    env: { HOME: path.join(profileRoot, 'home'), PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: path.join(profileRoot, 'config'),
      XDG_DATA_HOME: path.join(profileRoot, 'data'), XDG_CACHE_HOME: path.join(profileRoot, 'cache'),
      XDG_STATE_HOME: path.join(profileRoot, 'state'), TMPDIR: path.join(profileRoot, 'tmp'),
      NO_COLOR: '1', NODE_ENV: 'production', OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  }
  for (const folder of [profile.homePath, profile.tmpPath, profile.xdgConfigHome, profile.xdgDataHome,
    profile.xdgCacheHome, path.join(profileRoot, 'state')]) await mkdir(folder, { mode: 0o700 })
  const input: ColdInput = { schemaVersion: 1, caseId, version: options.version, hostKey: `TEST-cold-${options.version}`,
    dataRoot, evidence: output, binary: options.binary, helper: options.helper, profile }
  const configFile = path.join(work, 'controller-input.json')
  const handle = await open(configFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(JSON.stringify(input)); await handle.sync() } finally { await handle.close() }
  const inputDirectory = await open(work, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await inputDirectory.sync() } finally { await inputDirectory.close() }
  const controllerFile = path.join(import.meta.dir, 'fixtures/OpenCodeNativeColdController.ts')
  const launch = (role: 'A' | 'B' | 'sentinel') => {
    // A timed-out parent can never start a later controller/effect, even if an
    // earlier asynchronous operation eventually finishes.
    options.parentSignal.throwIfAborted()
    // Only the sentinel consumes control input; A/B exit from their finite role.
    const child = Bun.spawn([process.execPath, '--no-env-file', controllerFile, role, configFile], {
      cwd: project, env: { PATH: '/usr/bin:/bin', HOME: profile.homePath, USERPROFILE: profile.homePath,
        TMPDIR: profile.tmpPath, TZ: 'Etc/UTC' }, stdin: role === 'sentinel' ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    let exited = false, exitCode: number | null = null, exitSignal: string | null = null
    const progress: ColdProgress[] = []
    const stdoutDrain = drainColdOutput(child.stdout), stderrDrain = drainColdOutput(child.stderr, line => {
      captureColdProgress(line, caseId, role, progress)
    })
    const observation = Promise.all([child.exited.then(code => {
      exited = true; exitCode = Number.isSafeInteger(code) ? code : null
      const signal = child.signalCode
      exitSignal = signal == null ? null : ['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT',
        'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2', 'SIGXCPU', 'SIGXFSZ'].includes(signal) ? signal : 'other'
      return code
    }), stdoutDrain.result, stderrDrain.result])
      .then(([code, stdout, stderr]) => ({ code, signal: child.signalCode ?? null, stdout, stderr }))
    // Keep one observation and one exact original handle. Never rediscover or
    // signal a numeric PID, and never relaunch a controller after uncertainty.
    void observation.catch(() => undefined)
    const diagnostics = () => ({ exitObserved: exited, exitCode, signal: exitSignal,
      stdout: stdoutDrain.snapshot(), stderr: stderrDrain.snapshot(), progress: [...progress] })
    return { role, child, observation, stdoutDrain, stderrDrain, diagnostics, exited: () => exited }
  }
  const controllers: Array<ReturnType<typeof launch>> = []
  let sentinel: ReturnType<typeof launch> | undefined, completed = false
  let phase: NonNullable<Parameters<typeof evidence>[3]>['phase'] = 'source-binding'
  const finish = async (role: 'A' | 'B', controller: ReturnType<typeof launch>) => {
    const result = await deadline(controller.observation, 60000)
    await evidence(input, `${role}-controller-exit.json`, { schemaVersion: 1, caseId, controllerPid: controller.child.pid,
      exitCode: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
      observations: controller.diagnostics(), exitMeaning: 'JS-controller-exit-only; never-native-death' })
    fact(result.code === 0 && result.signal === null && !result.stdout.overflow && !result.stderr.overflow)
  }
  try {
    await evidence(input, 'source-binding.json', { schemaVersion: 1, caseId, sourceSha: options.sourceSha,
      controllerSha256: createHash('sha256').update(await readFile(controllerFile)).digest('hex'),
      harnessSha256: createHash('sha256').update(await readFile(import.meta.path)).digest('hex'),
      vendorVersion: options.version, execution: 'source-TS-under-standalone-Bun; not-packaged-controller' })
    // Immutable durable intent precedes every child, even the sentinel.
    // A timeout never erases it; only a completed result proves closure.
    await evidence(input, 'execution-pending.json', { schemaVersion: 1, caseId,
      outcome: 'pending', replayAllowed: false, privateStateMustBePreserved: true })
    phase = 'sentinel-start'
    sentinel = launch('sentinel'); controllers.push(sentinel)
    const ready = await waitReceipt<{ caseId: string; controllerPid: number; port: number }>(input, 'sentinel-ready.json')
    fact(ready.caseId === caseId && ready.controllerPid === sentinel.child.pid && Number.isSafeInteger(ready.port) && ready.port > 0 && ready.port <= 65535)
    const probe = async () => {
      fact(sentinel && !sentinel.exited())
      const response = await fetch(`http://127.0.0.1:${ready.port}/TEST-sentinel`, { redirect: 'error', signal: AbortSignal.timeout(2000) })
      fact(response.ok && (await response.json() as { caseId?: string }).caseId === caseId)
      return { controllerPid: ready.controllerPid, responded: true, originalControllerStillRunning: true }
    }
    phase = 'sentinel-before'
    await evidence(input, 'sentinel-before.json', await probe())
    phase = 'A-exit'
    const a = launch('A'); controllers.push(a); await finish('A', a)
    phase = 'A-validate'
    const first = await readPrivateJson<ReadyReceipt>(path.join(output, 'A-ready.json'))
    fact(first.controllerPid === a.child.pid && first.caseId === caseId)
    const authority = await readNativeAuthority(nativeAuthorityPath(profileRoot, input.hostKey))
    fact(authority.reference && authority.phase === 'published' && !await nativeExitConfirmed(authority) &&
      JSON.stringify(publicEpoch(authority.reference)) === JSON.stringify(first.epoch))
    await evidence(input, 'after-A-exit.json', { schemaVersion: 1, caseId, epoch: first.epoch,
      controllerAExited: true, authorityPhase: authority.phase, nativeExitConfirmed: false,
      hostWasNotDisposedByControllerA: true })
    phase = 'B-exit'
    const b = launch('B'); controllers.push(b); fact(b.child.pid !== a.child.pid); await finish('B', b)
    phase = 'B-validate'
    const stopped = await readPrivateJson<{ nativeExitConfirmed: boolean; authorityPhase: string }>(path.join(output, 'B-stopped.json'))
    fact(stopped.nativeExitConfirmed && stopped.authorityPhase === 'dead')
    phase = 'closure'
    await evidence(input, 'sentinel-after-stop.json', await probe())
    sentinel.child.stdin!.write(`close:${caseId}\n`); sentinel.child.stdin!.end()
    const sentinelExit = await deadline(sentinel.observation, 5000)
    fact(sentinelExit.code === 0 && sentinelExit.signal === null &&
      !sentinelExit.stdout.overflow && !sentinelExit.stderr.overflow)
    await evidence(input, 'sentinel-controller-exit.json', { schemaVersion: 1, caseId,
      controllerPid: sentinel.child.pid, exitCode: sentinelExit.code, signal: sentinelExit.signal,
      stdout: sentinelExit.stdout, stderr: sentinelExit.stderr, originalControllerClosureObserved: true })
    const finalAuthority = await readNativeAuthority(nativeAuthorityPath(profileRoot, input.hostKey))
    fact(finalAuthority.phase === 'dead' && finalAuthority.images.epoch === first.epoch.epoch &&
      await nativeExitConfirmed(finalAuthority))
    options.parentSignal.throwIfAborted()
    await evidence(input, 'result.json', { schemaVersion: 1, caseId, outcome: 'closure-observed', vendorVersion: options.version,
      distinctOsControllers: true, originalEpochRecovered: true, sessionCreateRead: true,
      nativeExitReceiptConfirmed: true, independentSentinelSurvived: true, privateStateKeptUntilSuiteCleanup: true,
      acceptance: 'Requires parent test completion; this receipt cannot clear a timed-out parent latch' })
    options.parentSignal.throwIfAborted()
    completed = true
    return { retiredImageRoot: finalAuthority.images.root }
  } catch (error) {
    await evidence(input, 'result.json', { schemaVersion: 1, caseId, outcome: 'unknown-or-failed', preserve: true,
      replayAllowed: false, numericPidFallbackAllowed: false, privateStatePreserved: true,
      controllers: controllers.map(value => ({ role: value.role, observations: value.diagnostics() })) }, { phase, error }).catch(() => undefined)
    throw new Error(`TEST cold recovery incomplete; preserve ${caseId} receipts and private state`)
  } finally {
    // Only the original sentinel stdin handle receives EOF. Do not stop a native
    // custodian or retry B after a timeout/unknown outcome. Retain all files.
    if (!completed && sentinel && !sentinel.exited()) {
      try { sentinel.child.stdin!.write(`close:${caseId}\n`); sentinel.child.stdin!.end() } catch { /* Original handle only. */ }
    }
    if (!completed) for (const controller of controllers) {
      if (controller.role === 'sentinel') {
        try { controller.child.stdin!.end() } catch { /* Original pipe may already be closed. */ }
      }
      // Bun's signal API may ultimately address a PID after a reaping race.
      // Never signal, even through the original JS child object.
      await deadline(controller.observation, 1000).catch(() => undefined)
      // Exit does not prove inherited stdout/stderr closure. Cancel both exact
      // readers under a finite budget, including for an already-exited child.
      await deadline(Promise.all([controller.stdoutDrain.cancel(), controller.stderrDrain.cancel()]), 1000)
        .catch(() => undefined)
      controller.child.unref()
    }
    if (!completed) await evidence(input, 'controller-handoff.json', { schemaVersion: 1, caseId, preserve: true,
      nativeOutcome: 'unknown; no Stop replay or PID fallback', controllers: controllers.map(value => ({
        role: value.role, controllerPid: value.child.pid, exitObserved: value.exited(), observations: value.diagnostics(),
      })) }).catch(() => undefined)
  }
}
