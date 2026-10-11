import type { ChildProcess } from 'node:child_process'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { resolveDirectWindowsLauncher, spawnPortableCli } from '../../../utils/portableCli.js'
import { nativePorts, query, type NativeHelperFailure, type NativeRow } from '../OpenCodeCursorAgentTreeKill.js'
import type { OpenCodeV2ReadRoots } from '../profile/OpenCodeV2ManagedConfig.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'

// TEST diagnostic instrumentation only; not the immutable d636 production closure.
type VersionProbePhase = 'started' | 'deadline' | 'candidate_reappeared' | 'initial_birth' |
  'anchor_birth' | 'candidate_birth' | 'confirmation_birth' | 'signal_birth' | 'census' |
  'unanchored_members' | 'candidate_identity_order' | 'confirmation_census' |
  'confirmation_member_absent' | 'signal' | 'pending_retirement' | 'final_census' | 'self_in_group' | 'sleep'
type VersionProbeTrace = {
  phase: VersionProbePhase; targetPid: number | null; targetRole: 'leader' | 'member' | null
  birthAvailable: boolean | null; alive: 'alive' | 'gone' | 'unknown' | null
  censusMemberCount: number | null; censusMemberPids: readonly number[]
}

/** Finite helper evidence only; raw query causes remain private to this process. */
export class OpenCodeVersionProbeCleanupError extends Error {
  constructor(cause: unknown, readonly helperFailure: NativeHelperFailure | null,
    readonly probeFailure: Readonly<VersionProbeTrace> | null = null) {
    super('cleanup_unknown', { cause })
  }
}

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
    let helperFailure: NativeHelperFailure | null = null
    const ports = nativePorts({}, failure => { helperFailure = failure })
    const pid = child.pid
    const trace: VersionProbeTrace = { phase: 'started', targetPid: null, targetRole: null,
      birthAvailable: null, alive: null, censusMemberCount: null, censusMemberPids: [] }
    const setPhase = (phase: VersionProbePhase, target: number | null = null) => {
      trace.phase = phase; trace.targetPid = target
      trace.targetRole = target === null ? null : target === pid ? 'leader' : 'member'
      trace.birthAvailable = null; trace.alive = null
    }
    const started = Date.now(), deadline = started + 8000
    // Match processKill.ts's 5s Windows process-birth query budget: cold
    // PowerShell/WMI startup can exceed 2s. Every helper still uses the
    // original 8s probe remainder; POSIX queries keep their 2s cap.
    const helperTimeout = process.platform === 'win32' ? 5000 : 2000
    let ended = false, closed = false, code: number | null = null
    let output = '', bytes = 0, failure: Error | undefined
    let stopping = false
    const fail = () => { failure ??= new Error('selection_unavailable'); stopping = true }
    const abort = () => fail()
    const acquisitionDeadline = started + 5000
    const timer = setTimeout(fail, 5000)
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
      if (remaining <= 0) { setPhase('deadline'); throw new Error('cleanup_unknown') }
      return remaining
    }
    const observe = <T>(work: Promise<T>) => boundOpenCodeRead(track(work), cap())
    const births = new Map<number, number>()
    const signalled = new Set<number>()
    // Census-only candidates confer no birth or signal authority. Keep vanished
    // snapshot members visible to later full tables, including surviving orphans
    // and numeric PID reuse after their original ancestry has disappeared.
    const unownedCandidates = new Set<number>()
    const assertCandidatesAbsent = (rows: Member[]) => {
      if (rows.some(row => !row.retired &&
        (unownedCandidates.has(row.pid) || unownedCandidates.has(row.ppid)))) {
        setPhase('candidate_reappeared'); throw new Error('cleanup_unknown')
      }
    }
    const birth = (target: number, phase: VersionProbePhase) => {
      setPhase(phase, target)
      const work = observe(ports.birth(target, Math.min(helperTimeout, cap())))
      // Observe the original promise; do not insert another awaited boundary.
      void work.then(value => { trace.birthAvailable = value !== null }, () => { trace.birthAvailable = null })
      return work
    }
    const alive = (target: number) => {
      const value = ports.alive(target)
      if (trace.targetPid !== target) trace.birthAvailable = null
      trace.targetPid = target; trace.targetRole = target === pid ? 'leader' : 'member'
      trace.alive = value
      return value
    }
    const sameBirth = async (target: number, expected: number, phase: VersionProbePhase): Promise<boolean> => {
      if (await birth(target, phase) === expected) return true
      // Exiting between a table snapshot and the birth read is retirement,
      // whereas a live replacement or unreadable live identity is unknown.
      if (alive(target) === 'gone') return false
      throw new Error('cleanup_unknown')
    }
    const table = async (phase: VersionProbePhase = 'census'): Promise<Member[]> => {
      setPhase(phase)
      trace.censusMemberCount = null; trace.censusMemberPids = []
      if (process.platform === 'win32') return (await observe(ports.tree(Math.min(helperTimeout, cap()))))
        .map(row => ({ ...row, group: null, retired: false }))
      // The detached POSIX spawn creates an isolated group. Unlike a PPID walk,
      // PGID membership still includes orphans after the leader has exited.
      const text = await observe(query('ps', ['-e', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat='], Math.min(2000, cap())))
      const seen = new Set<number>()
      return text.trim().split('\n').filter(Boolean).map(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
        if (!match) throw new Error('cleanup_unknown')
        const row = { pid: Number(match[1]), ppid: Number(match[2]), group: Number(match[3]), retired: match[4]!.startsWith('Z') }
        if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || seen.has(row.pid)) throw new Error('cleanup_unknown')
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
      return rows.filter(row => selected.has(row.pid))
    }
    try {
      if (signal?.aborted) fail()
      if (pid) {
        const initial = await birth(pid, 'initial_birth')
        if (initial !== null) births.set(pid, initial)
      }
      for (;;) {
        cap()
        const rows = await table(), group = members(rows)
        trace.censusMemberCount = group.length; trace.censusMemberPids = group.slice(0, 64).map(row => row.pid)
        assertCandidatesAbsent(rows)
        const live = rows.filter(row => !row.retired)
        // A live birth-checked member anchors group continuity. If the initial
        // leader vanished before identity capture, do not infer orphan ownership.
        let anchor: Member | undefined
        for (const row of group) {
          const expected = births.get(row.pid)
          if (expected !== undefined && await sameBirth(row.pid, expected, 'anchor_birth')) { anchor = row; break }
        }
        const additions = group.filter(row => !births.has(row.pid))
        if (additions.length && !anchor) { setPhase('unanchored_members'); throw new Error('cleanup_unknown') }
        const capturedAdditions: Member[] = []
        for (const row of additions) {
          if (row.pid === process.pid || row.pid === process.ppid) { setPhase('self_in_group', row.pid); throw new Error('cleanup_unknown') }
          const identity = await birth(row.pid, 'candidate_birth')
          if (identity === null) {
            if (alive(row.pid) !== 'gone') throw new Error('cleanup_unknown')
            cap()
            unownedCandidates.add(row.pid)
            continue
          }
          const parentBirth = process.platform === 'win32' ? births.get(row.ppid) : births.get(anchor!.pid)
          if (parentBirth === undefined || identity < parentBirth) { trace.phase = 'candidate_identity_order'; throw new Error('cleanup_unknown') }
          births.set(row.pid, identity)
          capturedAdditions.push(row)
        }
        if (additions.length) {
          const confirmationRows = await table('confirmation_census')
          const confirmation = members(confirmationRows)
          trace.censusMemberCount = confirmation.length; trace.censusMemberPids = confirmation.slice(0, 64).map(row => row.pid)
          assertCandidatesAbsent(confirmationRows)
          for (const row of capturedAdditions) {
            if (!confirmation.some(current => current.pid === row.pid && current.ppid === row.ppid)) {
              setPhase('confirmation_member_absent', row.pid)
              if (alive(row.pid) !== 'gone') throw new Error('cleanup_unknown')
              unownedCandidates.add(row.pid)
            } else if (!await sameBirth(row.pid, births.get(row.pid)!, 'confirmation_birth')) {
              unownedCandidates.add(row.pid)
            }
            cap()
          }
        }
        if (stopping) {
          for (const [target, identity] of births) {
            if (unownedCandidates.has(target) || !live.some(row => row.pid === target) || signalled.has(target)) continue
            if (!await sameBirth(target, identity, 'signal_birth')) continue
            cap()
            // Signals target captured births only, never a numeric group alone.
            try { trace.phase = 'signal'; ports.signal(target) } catch {
              if (alive(target) !== 'gone') throw new Error('cleanup_unknown')
            }
            signalled.add(target)
          }
        }
        const survivors = [...births.keys()].filter(target => live.some(row => row.pid === target))
        if (closed && group.length === 0 && survivors.length === 0) {
          setPhase('pending_retirement')
          await boundOpenCodeRead(close, cap())
          await boundOpenCodeRead(Promise.allSettled([...pending]), cap())
          if (pending.size) throw new Error('cleanup_unknown')
          if (unownedCandidates.size) {
            const finalRows = await table('final_census')
            const finalMembers = members(finalRows)
            trace.censusMemberCount = finalMembers.length; trace.censusMemberPids = finalMembers.slice(0, 64).map(row => row.pid)
            assertCandidatesAbsent(finalRows)
            if (finalMembers.length || finalRows.some(row => !row.retired && births.has(row.pid))) {
              throw new Error('cleanup_unknown')
            }
            await boundOpenCodeRead(Promise.allSettled([...pending]), cap())
            if (pending.size) throw new Error('cleanup_unknown')
            cap()
          }
          retired = true
          if (failure || !ended || code !== 0 || signal?.aborted) throw failure ?? new Error('selection_unavailable')
          return output
        }
        setPhase('sleep')
        await ports.sleep(Math.min(25, cap()))
      }
    } catch (error) {
      if (!retired) throw new OpenCodeVersionProbeCleanupError(error, helperFailure,
        Object.freeze({ ...trace, censusMemberPids: Object.freeze([...trace.censusMemberPids]) }))
      throw error
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
    }
  } finally {
    if (!child || retired) {
      try { await boundOpenCodeRead(track(roots.remove()), 2000) }
      catch (error) { throw new Error('cleanup_unknown', { cause: error }) }
      retained.delete(owner)
    }
  }
}
