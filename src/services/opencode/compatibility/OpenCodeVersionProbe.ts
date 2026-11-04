import type { ChildProcess } from 'node:child_process'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { resolveDirectWindowsLauncher, spawnPortableCli } from '../../../utils/portableCli.js'
import { classifyNativeHelperFailure, nativePorts, query, type NativeGeneration, type NativeHelperFailure, type NativeRow } from '../OpenCodeCursorAgentTreeKill.js'
import type { OpenCodeV2ReadRoots } from '../profile/OpenCodeV2ManagedConfig.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'

type ParentIdentityDiagnostic = Readonly<{
  reason: 'missing_parent_birth' | 'child_before_parent'
  pid: number
  ppid: number
  parentPid: number
  childBirth: number
  parentBirth: number | null
  parentCandidate: boolean
  anchorPid: number
  additionIndex: number
  ancestry: ReadonlyArray<Readonly<{ pid: number; ppid: number; capturedBirth: number | null; censusIndex: number }>>
  ancestryTruncated: boolean
}>

export type OpenCodeProbeTerminalDiagnostic = Readonly<{
  phase: 'initial_birth' | 'census' | 'candidate_validation' | 'anchor_identity' | 'addition_identity'
    | 'identity_confirmation' | 'signal' | 'retirement' | 'wait' | 'roots_remove'
  guard: 'deadline' | 'protected_candidate' | 'candidate_alive' | 'candidate_unknown' | 'strict_candidate_census'
    | 'identity_missing' | 'identity_changed_live' | 'anchor_missing' | 'protected_addition' | 'parent_identity'
    | 'ancestry_changed' | 'signal_failed_live' | 'final_pending' | 'final_retirement' | 'census_unreadable'
    | 'census_helper_failed' | 'roots_remove' | 'unexpected'
  closed?: boolean
  ended?: boolean
  exitCode?: number | null
  birthsCount?: number
  candidatesCount?: number
  pendingCount: number
  lastGroupCount?: number | null
  lastSurvivorCount?: number | null
  remainingMs?: number
  parentIdentity?: ParentIdentityDiagnostic
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
    ...(terminal.guard === 'parent_identity' && terminal.parentIdentity ? { parentIdentity: {
      reason: terminal.parentIdentity.reason, pid: terminal.parentIdentity.pid, ppid: terminal.parentIdentity.ppid,
      parentPid: terminal.parentIdentity.parentPid, childBirth: terminal.parentIdentity.childBirth,
      parentBirth: terminal.parentIdentity.parentBirth, parentCandidate: terminal.parentIdentity.parentCandidate,
      anchorPid: terminal.parentIdentity.anchorPid, additionIndex: terminal.parentIdentity.additionIndex,
      ancestry: terminal.parentIdentity.ancestry.slice(0, 8).map(row => ({
        pid: row.pid, ppid: row.ppid, capturedBirth: row.capturedBirth, censusIndex: row.censusIndex,
      })),
      ancestryTruncated: terminal.parentIdentity.ancestryTruncated || terminal.parentIdentity.ancestry.length > 8,
    } } : {}),
  })
  return diagnostics
}

/** `--version` must print and close within this window. On a busy Windows
 * runner the native exe alone took 3-4 s and more than 5 s through the
 * runtime. Darwin cold starts on loaded hosts can exceed 30 s; give native
 * acquisition bounded headroom without changing helper or cleanup budgets. */
export function versionAcquisitionMs(platform: NodeJS.Platform = process.platform): number {
  return platform === 'darwin' ? 60_000 : platform === 'win32' ? 15_000 : 5_000
}
/** Ownership cleanup keeps at least 3 s after acquisition. */
export const VERSION_CLEANUP_MS = 3_000
/** A raced capture-validation may recapture at most this often. */
export const PARENT_IDENTITY_CAPTURES = 3

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
  signal?: AbortSignal, acquisitionDeadlineMs?: number): Promise<string> {
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
    const ports = nativePorts({}, failure => { helperFailure = failure })
    // A passive display read may reduce acquisition, while owned retirement
    // retains its normal cleanup allowance. Ordinary callers keep their budget.
    if (acquisitionDeadlineMs !== undefined && (!Number.isFinite(acquisitionDeadlineMs) || acquisitionDeadlineMs <= Date.now()))
      throw new Error('selection_unavailable')
    const acquisitionMs = Math.min(versionAcquisitionMs(), acquisitionDeadlineMs === undefined ? Infinity : Math.max(1, acquisitionDeadlineMs - Date.now()))
    const deadlineMs = acquisitionMs + VERSION_CLEANUP_MS
    const started = Date.now(), deadline = started + deadlineMs
    const acquisitionDeadline = started + acquisitionMs
    const preexisting = new Map<number, NativeGeneration>()
    const protectedPids = new Set([process.pid, process.ppid].filter(pid => pid > 0))
    const protectedWitness = new Map<number, NativeGeneration>()
    if (process.platform === 'win32' && ports.existingWindows) {
      // This optional native-only read owns no helper process or private path.
      // A late/failed read grants no exclusion and can never launch a child.
      let witness: readonly NativeGeneration[] | null = null, settled = false
      const work = ports.existingWindows(acquisitionDeadline).then(
        value => { settled = true; return value }, error => { settled = true; throw error })
      try { witness = await boundOpenCodeRead(work, acquisitionMs, signal) }
      catch {
        // A bounded observation timeout is not settlement. Never start a probe
        // while a late optional witness is still reachable.
        if (!settled) throw new Error('selection_unavailable')
        // Settled native failure keeps the original strict ownership path.
      }
      if (witness && witness.length <= 4096) {
        const seen = new Set<number>()
        for (const row of witness) {
          if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.ppid) || row.ppid < 0
            || !Number.isSafeInteger(row.birth) || row.birth <= 0 || seen.has(row.pid)) {
            preexisting.clear(); break
          }
          seen.add(row.pid)
          if (row.pid !== process.pid && row.pid !== process.ppid) preexisting.set(row.pid, row)
        }
      }
    }
    if (process.platform === 'win32' && ports.protectedWindows) {
      let witness: readonly NativeGeneration[] | null = null, settled = false
      const work = ports.protectedWindows(acquisitionDeadline).then(
        value => { settled = true; return value }, error => { settled = true; throw error })
      try { witness = await boundOpenCodeRead(work, Math.max(1, acquisitionDeadline - Date.now()), signal) }
      catch { if (!settled) throw new Error('selection_unavailable') }
      if (witness && witness.length <= protectedPids.size) {
        for (const row of witness) {
          if (!protectedPids.has(row.pid) || !Number.isSafeInteger(row.ppid) || row.ppid < 0
            || !Number.isSafeInteger(row.birth) || row.birth <= 0 || protectedWitness.has(row.pid)) {
            protectedWitness.clear(); break
          }
          protectedWitness.set(row.pid, row)
        }
      }
    }
    signal?.throwIfAborted()
    if (Date.now() >= acquisitionDeadline) throw new Error('selection_unavailable')
    child = spawnPortableCli(launcher.command, launcher.args, { cwd: roots.root, env: roots.env,
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' })
    owner.child = child
    const pid = child.pid
    // Match processKill.ts's 5s Windows process-birth query budget: cold
    // PowerShell/WMI startup can exceed 2s. Every helper still uses the
    // probe remainder; Darwin census also needs cold-start headroom. Linux keeps 2s.
    const helperTimeout = process.platform === 'win32' || process.platform === 'darwin' ? 5000 : 2000
    let ended = false, closed = false, code: number | null = null
    let phase: OpenCodeProbeTerminalDiagnostic['phase'] = 'initial_birth'
    let terminalDiagnostic: OpenCodeProbeTerminalDiagnostic | undefined
    let lastGroupCount: number | null = null, lastSurvivorCount: number | null = null
    let output = '', bytes = 0, failure: Error | undefined
    let stopping = false
    const fail = () => { failure ??= new Error('selection_unavailable'); stopping = true }
    const abort = () => fail()
    const timer = setTimeout(fail, acquisitionDeadline - Date.now())
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
    const cleanupUnknown = (guard: OpenCodeProbeTerminalDiagnostic['guard'], parentIdentity?: ParentIdentityDiagnostic): Error => {
      terminalDiagnostic = { ...snapshot(phase, guard), ...(parentIdentity ? { parentIdentity } : {}) }
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
        let waiting = false
        // A live candidate may outlast its stale census row. Observe every
        // enrolled PID until independently gone; waiting grants no authority.
        for (const target of unownedCandidates) {
          const state = target === process.pid || target === process.ppid ? 'protected' : ports.alive(target)
          if (state === 'alive') waiting = true
          else if (state !== 'gone') throw cleanupUnknown(state === 'protected' ? 'protected_candidate' : 'candidate_unknown')
        }
        return candidates.length > 0 || waiting
      }
      if (rows.some(row => !row.retired &&
        (unownedCandidates.has(row.pid) || unownedCandidates.has(row.ppid)))) throw cleanupUnknown('strict_candidate_census')
      return false
    }
    const birth = (target: number) => observe(ports.birth(target, Math.min(helperTimeout, cap())))
    const sameBirth = async (target: number, expected: number): Promise<boolean> => {
      const current = await birth(target)
      if (current === expected) {
        if (process.platform === 'win32') {
          // A terminated Windows process object can retain its creation time.
          // Matching birth alone cannot anchor new census or signal authority.
          const state = ports.alive(target)
          if (state === 'gone') return false
          if (state !== 'alive') throw cleanupUnknown('candidate_unknown')
        }
        return true
      }
      // Exiting between a table snapshot and the birth read is retirement,
      // whereas a live replacement or unreadable live identity is unknown.
      if (ports.alive(target) === 'gone') return false
      throw cleanupUnknown(current === null ? 'identity_missing' : 'identity_changed_live')
    }
    const rawTable = async (): Promise<Member[]> => {
      phase = 'census'
      if (process.platform === 'win32') return (await observe(ports.tree(Math.min(helperTimeout, cap()))))
        .map(row => ({ ...row, group: null, retired: false }))
      // The detached POSIX spawn creates an isolated group. Unlike a PPID walk,
      // PGID membership still includes orphans after the leader has exited.
      const started = Date.now()
      let queryFailed = false
      const census = query('ps', ['-e', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat='], Math.min(helperTimeout, cap()))
        .catch(error => {
          helperFailure = classifyNativeHelperFailure('tree', error, Math.min(deadlineMs, Date.now() - started))
          queryFailed = true
          throw error
        })
      let text: string
      try { text = await observe(census) }
      catch (error) {
        // An observation deadline does not prove the helper has settled.
        if (queryFailed) terminalDiagnostic = snapshot('census', 'census_helper_failed')
        throw error
      }
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
    let edgeCuts = new Set<number>()
    const members = (rows: Member[], cuts = edgeCuts): Member[] => {
      if (process.platform !== 'win32') return rows.filter(row => row.group === pid && !row.retired)
      const selected = new Set<number>(pid ? [pid] : [])
      for (let changed = true; changed;) {
        changed = false
        for (const row of rows) if (!cuts.has(row.pid) && selected.has(row.ppid) && !selected.has(row.pid)) { selected.add(row.pid); changed = true }
      }
      // Acquire parent births first without discarding any census rows.
      const rank = new Map([...selected].map((target, index) => [target, index]))
      return rows.filter(row => selected.has(row.pid))
        .sort((left, right) => rank.get(left.pid)! - rank.get(right.pid)!)
    }
    // A pre-spawn generation is independent non-ownership evidence. Numeric
    // PPIDs may point to a newly reused parent PID; never grant that old edge
    // ownership of its subtree. Already captured owners remain independently
    // tracked, and all three census sites use this same generation check.
    const excluded = new Map<number, NativeGeneration>()
    const table = async (): Promise<Member[]> => {
      edgeCuts = new Set()
      const rows = await rawTable()
      if (process.platform !== 'win32' || !preexisting.size || !pid) return rows
      const rootBirth = births.get(pid)
      if (rootBirth === undefined) return rows
      const numeric = members(rows), cuts = new Set<number>()
      const protectedPath = numeric.some(row => protectedPids.has(row.pid))
      if (protectedPath) {
        // Numeric PPIDs alone cannot prove that an apparent ancestor belongs to
        // this probe. Only independently witnessed, still-live older protected
        // generations permit validating a foreign incoming edge below.
        if (!ports.protectedWindows || protectedWitness.size !== protectedPids.size) throw cleanupUnknown('protected_addition')
        const fresh = await observe(ports.protectedWindows(deadline))
        if (!fresh || fresh.length !== protectedPids.size) throw cleanupUnknown('protected_addition')
        const seen = new Set<number>()
        for (const row of fresh) {
          const witness = protectedWitness.get(row.pid)
          if (!witness || seen.has(row.pid) || row.birth !== witness.birth || row.ppid !== witness.ppid
            || row.birth >= rootBirth || ports.alive(row.pid) !== 'alive'
            || !rows.some(current => current.pid === row.pid && current.ppid === row.ppid)) throw cleanupUnknown('protected_addition')
          seen.add(row.pid)
        }
      }
      for (const [target, witness] of excluded) if (!rows.some(row => row.pid === target)) {
        // An absent seed cuts no edge. Still distinguish its original foreign
        // generation/retirement from an unreadable or reused live identity.
        phase = 'addition_identity'
        const current = await birth(target)
        if (current !== witness.birth && !(current === null && ports.alive(target) === 'gone')) {
          throw cleanupUnknown(current === null ? 'identity_missing' : 'identity_changed_live')
        }
      }
      for (const row of rows) {
        const established = excluded.has(row.pid)
        if (!established && !numeric.some(current => current.pid === row.pid)) continue
        if (births.has(row.pid) || unownedCandidates.has(row.pid)) continue
        const witness = excluded.get(row.pid) ?? preexisting.get(row.pid)
        if (!witness || witness.birth >= rootBirth) continue
        phase = 'addition_identity'
        if (row.ppid !== witness.ppid) throw cleanupUnknown('ancestry_changed')
        const current = await birth(row.pid)
        if (current !== witness.birth) throw cleanupUnknown(current === null ? 'identity_missing' : 'identity_changed_live')
        if (!established) {
          // New exclusions need the live original root. Once it naturally
          // retires, only these already-proven generations can be revalidated.
          if (!await sameBirth(pid, rootBirth)) throw cleanupUnknown('anchor_missing')
          const confirmation = await rawTable()
          phase = 'addition_identity'
          if (!confirmation.some(value => value.pid === row.pid && value.ppid === row.ppid)) throw cleanupUnknown('ancestry_changed')
          const confirmed = await birth(row.pid)
          if (confirmed !== witness.birth) throw cleanupUnknown(confirmed === null ? 'identity_missing' : 'identity_changed_live')
          if (!await sameBirth(pid, rootBirth)) throw cleanupUnknown('anchor_missing')
          excluded.set(row.pid, witness)
        }
        cuts.add(row.pid)
      }
      // Cut only a proven old generation's incoming membership edge. Preserve
      // the full census, including captured owners/candidates behind that edge
      // and cycles leading back to the captured root.
      if (protectedPath && members(rows, cuts).some(row => protectedPids.has(row.pid))) throw cleanupUnknown('protected_addition')
      edgeCuts = cuts
      return rows
    }
    try {
      if (signal?.aborted) fail()
      if (pid) {
        if (protectedPids.has(pid)) throw cleanupUnknown('protected_addition')
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
          const capturedGone = process.platform === 'win32' && !failure && !signal?.aborted && (!ended || code === 0) &&
            [...births.keys()].every(target => target !== process.pid && target !== process.ppid && ports.alive(target) === 'gone')
          if (process.platform !== 'win32' || births.size && !capturedGone) throw cleanupUnknown('anchor_missing')
          // A fast wrapper may close before birth capture, or leave a stale
          // census after its captured identities are independently gone.
          // OS retirement may precede delivery of Node exit/close events.
          // Waiting confers no signals; the original final close/exit checks
          // and strict fresh full tables still gate successful retirement.

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
        // Native census order does not guarantee parents precede children.
        // Validate the complete capture before publishing any signal authority.
        // A native capture can also race the parents' identity reads, so an
        // unconfirmed batch is recaptured with its parents inside the capture
        // window at most PARENT_IDENTITY_CAPTURES times before the refusal.
        let capturedAdditions: Member[] = []
        const additionBirths = new Map<number, number>()
        let parentIdentity: ParentIdentityDiagnostic | undefined
        let captureRows = rows, captureAdditions = additions
        for (let attempt = 1;; attempt++) {
          capturedAdditions = []
          additionBirths.clear()
          phase = 'addition_identity'
          for (const row of captureAdditions) {
            if (row.pid === process.pid || row.pid === process.ppid) throw cleanupUnknown('protected_addition')
            const identity = await birth(row.pid)
            if (identity === null) {
              if (ports.alive(row.pid) !== 'gone') throw cleanupUnknown('identity_missing')
              cap()
              unownedCandidates.add(row.pid)
              continue
            }
            additionBirths.set(row.pid, identity)
            capturedAdditions.push(row)
          }
          parentIdentity = undefined
          for (const row of capturedAdditions) {
            const parentBirth = process.platform === 'win32'
              ? births.get(row.ppid) ?? additionBirths.get(row.ppid) : births.get(anchor!.pid)
            const identity = additionBirths.get(row.pid)!
            if (parentBirth === undefined || identity < parentBirth) {
              // Explain this refusal using only the already captured census and
              // births. No further OS reads confer ownership or signal authority.
              const ancestry: Array<ParentIdentityDiagnostic['ancestry'][number]> = []
              const seen = new Set<number>()
              let ancestor: Member | undefined = row
              while (ancestor && ancestry.length < 8 && !seen.has(ancestor.pid)) {
                seen.add(ancestor.pid)
                ancestry.push({ pid: ancestor.pid, ppid: ancestor.ppid,
                  capturedBirth: births.get(ancestor.pid) ?? null, censusIndex: captureRows.indexOf(ancestor) })
                ancestor = ancestor.pid === pid ? undefined : captureRows.find(current => current.pid === ancestor!.ppid)
              }
              const parentPid = process.platform === 'win32' ? row.ppid : anchor!.pid
              parentIdentity = {
                reason: parentBirth === undefined ? 'missing_parent_birth' : 'child_before_parent',
                pid: row.pid, ppid: row.ppid, parentPid, childBirth: identity, parentBirth: parentBirth ?? null,
                parentCandidate: unownedCandidates.has(parentPid), anchorPid: anchor!.pid,
                additionIndex: captureAdditions.indexOf(row), ancestry, ancestryTruncated: ancestor !== undefined,
              }
              break
            }
          }
          if (!parentIdentity || attempt >= PARENT_IDENTITY_CAPTURES) break
          // Unreliable birth data: recapture only while a fresh full census
          // still shows the captured rows and their parents inside the window.
          const retryRows = await table()
          const windowed = capturedAdditions.every(row => {
            const parentPid = process.platform === 'win32' ? row.ppid : anchor!.pid
            return retryRows.some(current => current.pid === row.pid && current.ppid === row.ppid) &&
              (births.has(parentPid) || retryRows.some(current => current.pid === parentPid))
          })
          if (!windowed) break
          captureRows = retryRows
          captureAdditions = members(retryRows).filter(row => !births.has(row.pid))
        }
        if (parentIdentity) {
          phase = 'addition_identity'
          throw cleanupUnknown('parent_identity', parentIdentity)
        }
        // A genealogy confirmed by recapture is no longer census-only.
        for (const row of capturedAdditions) unownedCandidates.delete(row.pid)
        for (const [target, identity] of additionBirths) births.set(target, identity)
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
            if (protectedPids.has(target)) throw cleanupUnknown('protected_addition')
            if (unownedCandidates.has(target) || !live.some(row => row.pid === target) || signalled.has(target)) continue
            if (!await sameBirth(target, identity)) continue
            cap()
            // Signals target captured births only, never a numeric group alone.
            if (protectedPids.has(target)) throw cleanupUnknown('protected_addition')
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
          if (unownedCandidates.size || unanchoredRetirement || excluded.size) {
            const finalRows = await table()
            phase = 'retirement'
            assertCandidatesAbsent(finalRows, true)
            if (members(finalRows).length
              || finalRows.some(row => process.platform === 'win32'
                ? births.has(row.pid) : !row.retired && births.has(row.pid))) {
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
