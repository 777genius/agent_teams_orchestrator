import type { Subprocess } from 'bun'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

export type TrustedBuild = Readonly<{
  name: string
  cmd: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}>

export type TrustedBuildResult = Readonly<{
  name: string
  pid: number
  status: number
  elapsedMs: number
  stdout: string
}>

type Child = Pick<Subprocess, 'pid' | 'exited' | 'kill'> & {
  stdout?: ReadableStream<Uint8Array> | null
}

export type TrustedBuildSupervisorOptions = Readonly<{
  deadlineMs: number
  termGraceMs?: number
  killGraceMs?: number
  pollMs?: number
  spawn?: (build: TrustedBuild) => Child
}>

type LeaderIdentity = Readonly<{
  pid: number
  processGroup: number
  startTime: string
}>

type RunningBuild = {
  build: TrustedBuild
  child: Child
  identity?: LeaderIdentity
  startedAt: number
  stdout: Promise<string>
}

type TimerScope = Set<ReturnType<typeof setTimeout>>

function parseLeaderStat(contents: string): LeaderIdentity | undefined {
  const open = contents.indexOf('(')
  const close = contents.lastIndexOf(')')
  if (open <= 0 || close <= open) return undefined
  const pid = Number(contents.slice(0, open).trim())
  const fields = contents.slice(close + 1).trim().split(/\s+/)
  const processGroup = Number(fields[2])
  const startTime = fields[19]
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(processGroup) || !startTime) {
    return undefined
  }
  return { pid, processGroup, startTime }
}

async function readLeader(pid: number): Promise<LeaderIdentity | undefined> {
  return readFile(`/proc/${pid}/stat`, 'utf8').then(parseLeaderStat).catch(() => undefined)
}

async function isSameLeader(identity: LeaderIdentity): Promise<boolean> {
  const current = await readLeader(identity.pid)
  return current?.startTime === identity.startTime && current.processGroup === identity.pid
}

function processGroupIsAlive(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0)
    return true
  } catch {
    return false
  }
}

function delay(timers: TimerScope, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      resolve()
    }, ms)
    timers.add(timer)
  })
}

async function bounded<T>(
  timers: TimerScope,
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
        timers.add(timer)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
      timers.delete(timer)
    }
  }
}

async function diagnostic(timers: TimerScope, state: RunningBuild): Promise<unknown> {
  const status = await bounded(
    timers,
    readFile(`/proc/${state.child.pid}/status`, 'utf8').then(value => value.slice(0, 4_096))
      .catch(() => ''),
    100,
    `${state.build.name} diagnostics`,
  ).catch(error => String(error))
  return {
    name: state.build.name,
    pid: state.child.pid,
    elapsedMs: Date.now() - state.startedAt,
    stableLeader: state.identity ? await bounded(
      timers,
      isSameLeader(state.identity),
      100,
      `${state.build.name} identity diagnostics`,
    ).catch(error => String(error)) : false,
    status,
  }
}

async function termInitiallyStableGroups(states: RunningBuild[]): Promise<boolean[]> {
  const ownedGroups = states.map(() => false)
  for (const [index, state] of states.entries()) {
    // This is the sole ownership-establishment point: validate the captured
    // leader identity and signal its group without an intervening await.
    if (!state.identity || !await isSameLeader(state.identity)) continue
    ownedGroups[index] = true
    try { process.kill(-state.identity.processGroup, 'SIGTERM') } catch {}
  }
  return ownedGroups
}

function signalOwnedGroups(
  states: RunningBuild[],
  ownedGroups: boolean[],
  signal: NodeJS.Signals,
): Promise<void> {
  for (const [index, state] of states.entries()) {
    if (!ownedGroups[index] || !state.identity) continue
    try { process.kill(-state.identity.processGroup, signal) } catch {}
  }
  return Promise.resolve()
}

function ownedGroupsAlive(states: RunningBuild[], ownedGroups: boolean[]): boolean[] {
  return states.map((state, index) => Boolean(
    ownedGroups[index] && state.identity && processGroupIsAlive(state.identity.processGroup),
  ))
}

async function waitForOwnedGroupsGone(
  timers: TimerScope,
  states: RunningBuild[],
  ownedGroups: boolean[],
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ownedGroupsAlive(states, ownedGroups).every(alive => !alive)) return true
    await delay(timers, Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
  return ownedGroupsAlive(states, ownedGroups).every(alive => !alive)
}

async function cleanupKnownGroups(
  timers: TimerScope,
  states: RunningBuild[],
  termGraceMs: number,
  killGraceMs: number,
  pollMs: number,
): Promise<unknown> {
  // Authority to signal a group is established exactly once, immediately before
  // TERM, from the original leader's PID/start-time/PGID identity. After TERM a
  // leader may exit while its same-group descendants remain. A group which was
  // verified here stays the same kernel process group until it disappears, so
  // escalation follows group liveness and never samples a new group as owned.
  const initiallyAlive = await termInitiallyStableGroups(states)
  const goneAfterTerm = await waitForOwnedGroupsGone(
    timers, states, initiallyAlive, termGraceMs, pollMs,
  )
  if (!goneAfterTerm) {
    // Recheck the already-owned groups immediately before escalation. Crucially,
    // this does not require the original leader to remain present after TERM.
    const stillAlive = ownedGroupsAlive(states, initiallyAlive)
    await signalOwnedGroups(states, stillAlive, 'SIGKILL')
  }
  const gone = goneAfterTerm || await waitForOwnedGroupsGone(
    timers, states, initiallyAlive, killGraceMs, pollMs,
  )
  await Promise.all(states.map(state => bounded(timers, Promise.all([
    state.child.exited, state.stdout,
  ]),
    killGraceMs,
    `${state.build.name} child reap/output drain`,
  ).catch(() => undefined)))
  return {
    initiallyAlive,
    goneAfterTerm,
    gone,
    finalStableLeaders: await Promise.all(states.map(
      state => state.identity ? isSameLeader(state.identity) : false,
    )),
    finalGroupsAlive: ownedGroupsAlive(states, initiallyAlive),
  }
}

function defaultSpawn(build: TrustedBuild): Child {
  return Bun.spawn({
    cmd: build.cmd,
    cwd: build.cwd,
    env: build.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
    detached: true,
  })
}

/**
 * Supervises trusted build.ts children. The containment invariant is deliberately
 * narrow: build.ts and its synchronous toolchain do not daemonize, call setsid,
 * or intentionally leave their fresh process group. This helper makes no claim
 * about arbitrary or adversarial descendants.
 */
export async function superviseTrustedBuilds(
  builds: TrustedBuild[],
  options: TrustedBuildSupervisorOptions,
): Promise<TrustedBuildResult[]> {
  if (process.platform !== 'linux' || !existsSync('/proc/self/stat')) {
    throw new Error('trusted build supervisor requires Linux /proc process-group semantics')
  }
  const spawn = options.spawn ?? defaultSpawn
  const termGraceMs = options.termGraceMs ?? 1_000
  const killGraceMs = options.killGraceMs ?? 2_000
  const pollMs = options.pollMs ?? 20
  const states: RunningBuild[] = []
  const timers: TimerScope = new Set()
  let results: TrustedBuildResult[] | undefined
  let failure: unknown
  let cleanup: unknown
  let cleanupFailure: unknown
  let failureDiagnostics: unknown[] = []

  try {
    // Spawning is intentionally sequential and guarded from the first child.
    // Waiting begins after custody of every successfully spawned child is recorded.
    for (const build of builds) {
      const startedAt = Date.now()
      const child = spawn(build)
      const stdout = child.stdout
        ? new Response(child.stdout).text()
        : Promise.resolve('')
      // Start identity capture immediately, but let an already-published exit
      // win. That status needs no signaling and must not let a recycled PID be
      // sampled as this child's identity.
      const capture = await Promise.race([
        child.exited.then(() => ({ exited: true as const, identity: undefined })),
        readLeader(child.pid).then(identity => ({ exited: false as const, identity })),
      ])
      if (capture.exited) {
        states.push({ build, child, startedAt, stdout })
        continue
      }
      const identity = capture.identity
      if (!identity || identity.pid !== child.pid || identity.processGroup !== child.pid) {
        // /proc can disappear before Bun publishes an already-completed exit.
        // Give that known status one event-loop turn; a process which really is
        // still running without the required stable group remains a hard error.
        const exitedBeforeCapture = await Promise.race([
          child.exited.then(() => true),
          delay(timers, 0).then(() => false),
        ])
        if (exitedBeforeCapture) {
          states.push({ build, child, startedAt, stdout })
          continue
        }
        try { child.kill('SIGKILL') } catch {}
        await bounded(timers, child.exited, killGraceMs, `${build.name} rejected child reap`)
          .catch(() => undefined)
        throw new Error(`${build.name} did not start as a stable process-group leader`)
      }
      states.push({ build, child, identity, startedAt, stdout })
    }

    results = await Promise.all(states.map(async state => {
      const remainingMs = Math.max(1,
        options.deadlineMs - (Date.now() - state.startedAt))
      const [status, stdout] = await bounded(timers, Promise.all([
        state.child.exited, state.stdout,
      ]),
        remainingMs,
        `${state.build.name} child deadline/output drain`,
      )
      if (status !== 0) throw new Error(`${state.build.name} exited ${status}`)
      return {
        name: state.build.name,
        pid: state.child.pid,
        status,
        elapsedMs: Date.now() - state.startedAt,
        stdout: stdout.trim(),
      }
    }))
  } catch (error) {
    failure = error
    failureDiagnostics = await Promise.all(states.map(state => diagnostic(timers, state)))
  } finally {
    try {
      cleanup = await cleanupKnownGroups(timers, states, termGraceMs, killGraceMs, pollMs)
    } catch (error) {
      cleanupFailure = error
    } finally {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }

  const cleanupRecord = (cleanup ?? {}) as {
    gone?: boolean
    finalStableLeaders?: boolean[]
    finalGroupsAlive?: boolean[]
  }
  if (failure !== undefined || cleanupFailure !== undefined || !cleanupRecord.gone ||
    cleanupRecord.finalStableLeaders?.some(Boolean) ||
    cleanupRecord.finalGroupsAlive?.some(Boolean)) {
    throw new Error(JSON.stringify({
      phase: 'trusted build supervision failure',
      error: String(failure ?? cleanupFailure ?? 'cleanup incomplete'),
      cleanupError: cleanupFailure === undefined ? null : String(cleanupFailure),
      diagnostics: failureDiagnostics,
      cleanup,
    }))
  }
  return results ?? []
}
