import type { ChildProcess } from 'node:child_process'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { resolveDirectWindowsLauncher, spawnPortableCli } from '../../../utils/portableCli.js'
import { nativePorts, query, type NativeHelperFailure, type NativeRow } from '../OpenCodeCursorAgentTreeKill.js'
import type { OpenCodeV2ReadRoots } from '../profile/OpenCodeV2ManagedConfig.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'

export type OpenCodeProbeTerminalDiagnostic = Readonly<{
  phase: 'initial_birth' | 'census' | 'candidate_validation' | 'anchor_identity' | 'addition_identity'
    | 'identity_confirmation' | 'signal' | 'retirement' | 'wait' | 'roots_remove'
  guard: 'deadline' | 'protected_candidate' | 'candidate_alive' | 'candidate_unknown' | 'strict_candidate_census'
    | 'identity_missing' | 'identity_changed_live' | 'anchor_missing' | 'protected_addition' | 'parent_identity'
    | 'ancestry_changed' | 'signal_failed_live' | 'final_pending' | 'final_retirement' | 'census_unreadable'
    | 'roots_remove' | 'unexpected'
  closed?: boolean
  ended?: boolean
  exitCode?: number | null
  birthsCount?: number
  candidatesCount?: number
  pendingCount: number
  lastGroupCount?: number | null
  lastSurvivorCount?: number | null
  remainingMs?: number
}>

/** Last helper observation and actual terminal decision are separate evidence. */
export class OpenCodeVersionProbeCleanupError extends Error {
  constructor(cause: unknown, readonly helperFailure: NativeHelperFailure | null,
    readonly terminalDiagnostic?: OpenCodeProbeTerminalDiagnostic) {
    super('cleanup_unknown', { cause })
  }
}

/** Public projection excludes raw causes, stderr, paths and unrecognized fields. */
export function getOpenCodeVersionProbeDiagnostics(error: unknown) {
  if (!(error instanceof OpenCodeVersionProbeCleanupError)) return []
  const helper = error.helperFailure, terminal = error.terminalDiagnostic
  const diagnostics = []
  if (helper) diagnostics.push({
    code: 'opencode_version_probe_helper_failed', evidence: 'last_observed',
    operation: helper.operation, reason: helper.reason, exitCode: helper.exitCode, elapsedMs: helper.elapsedMs,
    ...(helper.helperCause ? { helperCause: {
      stage: helper.helperCause.stage, category: helper.helperCause.category,
      hresult: helper.helperCause.hresult, nativeErrorCode: helper.helperCause.nativeErrorCode,
    } } : {}),
  })
  if (terminal) diagnostics.push({
    code: 'opencode_version_probe_cleanup_unknown', phase: terminal.phase, guard: terminal.guard,
    closed: terminal.closed, ended: terminal.ended, exitCode: terminal.exitCode,
    birthsCount: terminal.birthsCount, candidatesCount: terminal.candidatesCount, pendingCount: terminal.pendingCount,
    lastGroupCount: terminal.lastGroupCount, lastSurvivorCount: terminal.lastSurvivorCount, remainingMs: terminal.remainingMs,
  })
  return diagnostics
}

/** `--version` must print and close within this window. On a busy Windows
 * runner the native exe alone took 3-4 s and more than 5 s through the
 * runtime; the app's own version check allows 30 s. POSIX keeps 5 s. */
export function versionAcquisitionMs(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? 15_000 : 5_000
}
/** Ownership cleanup keeps at least 3 s after acquisition. */
export const VERSION_CLEANUP_MS = 3_000

type Member = NativeRow & { group: number | null; retired: boolean }
// An observation deadline is not a retirement receipt. Keep unresolved owners
// reachable, including native queries whose close has not yet been observed.
type ProbeOwner = { child?: ChildProcess; roots: OpenCodeV2ReadRoots; pending: Set<Promise<unknown>> }
const retained = new Set<ProbeOwner>()

/** Resolve a legacy script loader before entering private roots; do not inherit PATH. */
async function versionLauncher(executable: string): Promise<{ command: string; args: string[] }> {
  const windows = resolveDirectWindowsLauncher(executable)
  if (windows) {
    const command = path.isAbsolute(windows.command) ? windows.command : Bun.which(windows.command)
    if (!command) throw new Error('selection_unavailable')
    return { command, args: [...windows.argsPrefix, '--version'] }
  }
  const handle = await open(executable, 'r')
  let shebang: string
  try {
    const bytes = Buffer.alloc(256), result = await handle.read(bytes, 0, bytes.length, 0)
    shebang = bytes.subarray(0, result.bytesRead).toString('utf8').split('\n')[0]!
  } finally { await handle.close() }
  const loader = /^#!\s*\/usr\/bin\/env\s+(node|bun)\s*$/.exec(shebang)?.[1]
  if (loader) {
    const command = Bun.which(loader)
    if (!command) throw new Error('selection_unavailable')
    return { command, args: [executable, '--version'] }
  }
  return { command: executable, args: ['--version'] }
}

/** Private --version admission, including children which inherit its stdout. */
export async function readOpenCodeOwnedVersion(executable: string, roots: OpenCodeV2ReadRoots,
  signal?: AbortSignal): Promise<string> {
  let child: ChildProcess | undefined
  let retired = false
  let helperFailure: NativeHelperFailure | null = null
  let snapshotCleanup: ((phase: OpenCodeProbeTerminalDiagnostic['phase'],
    guard: OpenCodeProbeTerminalDiagnostic['guard']) => OpenCodeProbeTerminalDiagnostic) | undefined
  const pending = new Set<Promise<unknown>>()
  const owner: ProbeOwner = { roots, pending }
  retained.add(owner)
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work)
    void work.finally(() => pending.delete(work)).catch(() => undefined)
    return work
  }
  try {
    signal?.throwIfAborted()
    const launcher = await versionLauncher(executable)
    signal?.throwIfAborted()
    child = spawnPortableCli(launcher.command, launcher.args, { cwd: roots.root, env: roots.env,
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' })
    owner.child = child
    const ports = nativePorts({}, failure => { helperFailure = failure })
    const pid = child.pid
    const acquisitionMs = versionAcquisitionMs(), deadlineMs = acquisitionMs + VERSION_CLEANUP_MS
    const started = Date.now(), deadline = started + deadlineMs
    // Match processKill.ts's 5s Windows process-birth query budget: cold
    // PowerShell/WMI startup can exceed 2s. Every helper still uses the
    // probe remainder; POSIX queries keep their 2s cap.
    const helperTimeout = process.platform === 'win32' ? 5000 : 2000
    let ended = false, closed = false, code: number | null = null
    let phase: OpenCodeProbeTerminalDiagnostic['phase'] = 'initial_birth'
    let terminalDiagnostic: OpenCodeProbeTerminalDiagnostic | undefined
    let lastGroupCount: number | null = null, lastSurvivorCount: number | null = null
    let output = '', bytes = 0, failure: Error | undefined
    let stopping = false
    const fail = () => { failure ??= new Error('selection_unavailable'); stopping = true }
    const abort = () => fail()
    const acquisitionDeadline = started + acquisitionMs
    const timer = setTimeout(fail, acquisitionMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > 4096) fail()
      else output += chunk.toString('utf8')
    })
    child.once('error', () => { fail(); if (!child?.pid) ended = true })
    child.once('exit', value => { ended = true; code = value; stopping = true })
    const close = track(new Promise<void>(resolve => {
      child!.once('close', () => {
        // Close ends version acquisition, not the bounded ownership cleanup.
        // Preserve the deadline if event-loop delay delivered close too late.
        if (Date.now() >= acquisitionDeadline) fail()
        clearTimeout(timer)
        closed = true
        resolve()
      })
    }))
    const cap = () => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw cleanupUnknown('deadline')
      return remaining
    }
    const observe = <T>(work: Promise<T>) => boundOpenCodeRead(track(work), cap())
    const births = new Map<number, number>()
    const signalled = new Set<number>()
    // Census-only candidates confer no birth or signal authority. Keep vanished
    // snapshot members visible to later full tables, including surviving orphans
    // and numeric PID reuse after their original ancestry has disappeared.
    const unownedCandidates = new Set<number>()
    const snapshot = (at: OpenCodeProbeTerminalDiagnostic['phase'],
      guard: OpenCodeProbeTerminalDiagnostic['guard']): OpenCodeProbeTerminalDiagnostic => ({
      phase: at, guard, closed, ended, exitCode: code,
      birthsCount: Math.min(4096, births.size), candidatesCount: Math.min(4096, unownedCandidates.size),
      pendingCount: Math.min(4096, pending.size), lastGroupCount, lastSurvivorCount,
      remainingMs: Math.max(0, Math.min(deadlineMs, deadline - Date.now())),
    })
    snapshotCleanup = snapshot
    const cleanupUnknown = (guard: OpenCodeProbeTerminalDiagnostic['guard']): Error => {
      terminalDiagnostic = snapshot(phase, guard)
      return new Error('cleanup_unknown')
    }
    let unanchoredRetirement = false
    const assertCandidatesAbsent = (rows: Member[], strict = !unanchoredRetirement): boolean => {
      if (!strict) {
        // Keep ancestry across stale tables and reparenting, without acquiring
        // birth or signal authority from any numeric census candidate.
        for (let changed = true; changed;) {
          changed = false
          for (const row of rows) if (unownedCandidates.has(row.ppid) && !unownedCandidates.has(row.pid)) {
            unownedCandidates.add(row.pid); changed = true
          }
        }
        const candidates = rows.filter(row => unownedCandidates.has(row.pid))
        for (const row of candidates) {
          const state = row.pid === process.pid || row.pid === process.ppid ? 'protected' : ports.alive(row.pid)
          if (state !== 'gone') {
            throw cleanupUnknown(state === 'protected' ? 'protected_candidate'
              : state === 'alive' ? 'candidate_alive' : 'candidate_unknown')
          }
        }
        return candidates.length > 0
      }
      if (rows.some(row => !row.retired &&
        (unownedCandidates.has(row.pid) || unownedCandidates.has(row.ppid)))) throw cleanupUnknown('strict_candidate_census')
      return false
    }
    const birth = (target: number) => observe(ports.birth(target, Math.min(helperTimeout, cap())))
    const sameBirth = async (target: number, expected: number): Promise<boolean> => {
      const current = await birth(target)
      if (current === expected) return true
      // Exiting between a table snapshot and the birth read is retirement,
      // whereas a live replacement or unreadable live identity is unknown.
      if (ports.alive(target) === 'gone') return false
      throw cleanupUnknown(current === null ? 'identity_missing' : 'identity_changed_live')
    }
    const table = async (): Promise<Member[]> => {
      phase = 'census'
      if (process.platform === 'win32') return (await observe(ports.tree(Math.min(helperTimeout, cap()))))
        .map(row => ({ ...row, group: null, retired: false }))
      // The detached POSIX spawn creates an isolated group. Unlike a PPID walk,
      // PGID membership still includes orphans after the leader has exited.
      const text = await observe(query('ps', ['-e', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat='], Math.min(2000, cap())))
      const seen = new Set<number>()
      return text.trim().split('\n').filter(Boolean).map(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
        if (!match) throw cleanupUnknown('census_unreadable')
        const row = { pid: Number(match[1]), ppid: Number(match[2]), group: Number(match[3]), retired: match[4]!.startsWith('Z') }
        if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || seen.has(row.pid)) throw cleanupUnknown('census_unreadable')
        seen.add(row.pid)
        return row
      })
    }
    const members = (rows: Member[]): Member[] => {
      if (process.platform !== 'win32') return rows.filter(row => row.group === pid && !row.retired)
      const selected = new Set<number>(pid ? [pid] : [])
      for (let changed = true; changed;) {
        changed = false
        for (const row of rows) if (selected.has(row.ppid) && !selected.has(row.pid)) { selected.add(row.pid); changed = true }
      }
      // Acquire parent births first without discarding any census rows.
      const rank = new Map([...selected].map((target, index) => [target, index]))
      return rows.filter(row => selected.has(row.pid))
        .sort((left, right) => rank.get(left.pid)! - rank.get(right.pid)!)
    }
    try {
      if (signal?.aborted) fail()
      if (pid) {
        const initial = await birth(pid)
        if (initial !== null) births.set(pid, initial)
      }
      for (;;) {
        cap()
        const rows = await table(), group = members(rows)
        lastGroupCount = Math.min(4096, group.length)
        phase = 'candidate_validation'
        const candidatesPresent = assertCandidatesAbsent(rows)
        if (unanchoredRetirement && candidatesPresent) {
          phase = 'wait'
          await ports.sleep(Math.min(25, cap()))
          continue
        }
        const live = rows.filter(row => !row.retired)
        // A live birth-checked member anchors group continuity. If the initial
        // leader vanished before identity capture, do not infer orphan ownership.
        let anchor: Member | undefined
        phase = 'anchor_identity'
        for (const row of group) {
          const expected = births.get(row.pid)
          if (expected !== undefined && await sameBirth(row.pid, expected)) { anchor = row; break }
        }
        const additions = group.filter(row => !births.has(row.pid))
        if (additions.length && !anchor) {
          const capturedRetirement = process.platform === 'win32' && closed && ended && code === 0 && !failure && !signal?.aborted &&
            [...births.keys()].every(target => target !== process.pid && target !== process.ppid && ports.alive(target) === 'gone')
          if (process.platform !== 'win32' || births.size && !capturedRetirement) throw cleanupUnknown('anchor_missing')
          // A fast wrapper may close before birth capture, or leave a stale
          // census after its captured identities are independently gone.
          // Waiting confers no signals; strict fresh full tables gate retirement.
          unanchoredRetirement = true
          if (pid) unownedCandidates.add(pid)
          for (const target of births.keys()) unownedCandidates.add(target)
          for (const row of group) unownedCandidates.add(row.pid)
          phase = 'candidate_validation'
          assertCandidatesAbsent(rows)
          phase = 'wait'
          await ports.sleep(Math.min(25, cap()))
          continue
        }
        const capturedAdditions: Member[] = []
        phase = 'addition_identity'
        for (const row of additions) {
          if (row.pid === process.pid || row.pid === process.ppid) throw cleanupUnknown('protected_addition')
          const identity = await birth(row.pid)
          if (identity === null) {
            if (ports.alive(row.pid) !== 'gone') throw cleanupUnknown('identity_missing')
            cap()
            unownedCandidates.add(row.pid)
            continue
          }
          const parentBirth = process.platform === 'win32' ? births.get(row.ppid) : births.get(anchor!.pid)
          if (parentBirth === undefined || identity < parentBirth) throw cleanupUnknown('parent_identity')
          births.set(row.pid, identity)
          capturedAdditions.push(row)
        }
        if (additions.length) {
          const confirmationRows = await table()
          phase = 'candidate_validation'
          assertCandidatesAbsent(confirmationRows)
          const confirmation = members(confirmationRows)
          phase = 'identity_confirmation'
          for (const row of capturedAdditions) {
            if (!confirmation.some(current => current.pid === row.pid && current.ppid === row.ppid)) {
              if (ports.alive(row.pid) !== 'gone') throw cleanupUnknown('ancestry_changed')
              unownedCandidates.add(row.pid)
            } else if (!await sameBirth(row.pid, births.get(row.pid)!)) {
              unownedCandidates.add(row.pid)
            }
            cap()
          }
        }
        if (stopping) {
          phase = 'signal'
          for (const [target, identity] of births) {
            if (unownedCandidates.has(target) || !live.some(row => row.pid === target) || signalled.has(target)) continue
            if (!await sameBirth(target, identity)) continue
            cap()
            // Signals target captured births only, never a numeric group alone.
            try { ports.signal(target) } catch {
              if (ports.alive(target) !== 'gone') throw cleanupUnknown('signal_failed_live')
            }
            signalled.add(target)
          }
        }
        const survivors = [...births.keys()].filter(target => live.some(row => row.pid === target))
        lastSurvivorCount = Math.min(4096, survivors.length)
        if (closed && group.length === 0 && survivors.length === 0) {
          phase = 'retirement'
          await boundOpenCodeRead(close, cap())
          await boundOpenCodeRead(Promise.allSettled([...pending]), cap())
          if (pending.size) throw cleanupUnknown('final_pending')
          if (unownedCandidates.size) {
            const finalRows = await table()
            phase = 'retirement'
            assertCandidatesAbsent(finalRows, true)
            if (members(finalRows).length || finalRows.some(row => !row.retired && births.has(row.pid))) {
              throw cleanupUnknown('final_retirement')
            }
            await boundOpenCodeRead(Promise.allSettled([...pending]), cap())
            if (pending.size) throw cleanupUnknown('final_pending')
            cap()
          }
          retired = true
          if (failure || !ended || code !== 0 || signal?.aborted) throw failure ?? new Error('selection_unavailable')
          return output
        }
        phase = 'wait'
        await ports.sleep(Math.min(25, cap()))
      }
    } catch (error) {
      if (!retired) throw new OpenCodeVersionProbeCleanupError(error, helperFailure,
        terminalDiagnostic ?? snapshot(phase, 'unexpected'))
      throw error
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
    }
  } finally {
    if (!child || retired) {
      try { await boundOpenCodeRead(track(roots.remove()), 2000) }
      catch (error) { throw new OpenCodeVersionProbeCleanupError(error, helperFailure,
        snapshotCleanup?.('roots_remove', 'roots_remove') ?? { phase: 'roots_remove', guard: 'roots_remove', pendingCount: Math.min(4096, pending.size) }) }
      retained.delete(owner)
    }
  }
}
