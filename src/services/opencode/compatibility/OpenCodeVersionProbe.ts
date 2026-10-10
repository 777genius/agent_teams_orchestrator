import type { ChildProcess } from 'node:child_process'
import { spawnPortableCli } from '../../../utils/portableCli.js'
import { nativePorts, query, type NativeHelperFailure, type NativeRow } from '../OpenCodeCursorAgentTreeKill.js'
import type { OpenCodeV2ReadRoots } from '../profile/OpenCodeV2ManagedConfig.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'

/** Finite helper evidence only; raw query causes remain private to this process. */
export class OpenCodeVersionProbeCleanupError extends Error {
  constructor(cause: unknown, readonly helperFailure: NativeHelperFailure | null) {
    super('cleanup_unknown', { cause })
  }
}

type Member = NativeRow & { group: number | null; retired: boolean }
// An observation deadline is not a retirement receipt. Keep unresolved owners
// reachable, including native queries whose close has not yet been observed.
type ProbeOwner = { child?: ChildProcess; roots: OpenCodeV2ReadRoots; pending: Set<Promise<unknown>> }
const retained = new Set<ProbeOwner>()

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
    child = spawnPortableCli(executable, ['--version'], { cwd: roots.root, env: roots.env,
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' })
    owner.child = child
    let helperFailure: NativeHelperFailure | null = null
    const ports = nativePorts({}, failure => { helperFailure = failure })
    const pid = child.pid
    const started = Date.now(), deadline = started + 8000
    let ended = false, closed = false, code: number | null = null
    let output = '', bytes = 0, failure: Error | undefined
    let stopping = false
    const fail = () => { failure ??= new Error('selection_unavailable'); stopping = true }
    const abort = () => fail()
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
      child!.once('close', () => { closed = true; resolve() })
    }))
    const cap = () => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('cleanup_unknown')
      return remaining
    }
    const observe = <T>(work: Promise<T>) => boundOpenCodeRead(track(work), cap())
    const births = new Map<number, number>()
    const signalled = new Set<number>()
    const birth = (target: number) => observe(ports.birth(target, Math.min(2000, cap())))
    const sameBirth = async (target: number, expected: number): Promise<boolean> => {
      if (await birth(target) === expected) return true
      // Exiting between a table snapshot and the birth read is retirement,
      // whereas a live replacement or unreadable live identity is unknown.
      if (ports.alive(target) === 'gone') return false
      throw new Error('cleanup_unknown')
    }
    const table = async (): Promise<Member[]> => {
      if (process.platform === 'win32') return (await observe(ports.tree(Math.min(2000, cap()))))
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
        const initial = await birth(pid)
        if (initial !== null) births.set(pid, initial)
      }
      for (;;) {
        cap()
        const rows = await table(), group = members(rows)
        const live = rows.filter(row => !row.retired)
        // A live birth-checked member anchors group continuity. If the initial
        // leader vanished before identity capture, do not infer orphan ownership.
        let anchor: Member | undefined
        for (const row of group) {
          const expected = births.get(row.pid)
          if (expected !== undefined && await sameBirth(row.pid, expected)) { anchor = row; break }
        }
        const additions = group.filter(row => !births.has(row.pid))
        if (additions.length && !anchor) throw new Error('cleanup_unknown')
        for (const row of additions) {
          if (row.pid === process.pid || row.pid === process.ppid) throw new Error('cleanup_unknown')
          const identity = await birth(row.pid)
          const parentBirth = process.platform === 'win32' ? births.get(row.ppid) : births.get(anchor!.pid)
          if (identity === null || parentBirth === undefined || identity < parentBirth) throw new Error('cleanup_unknown')
          births.set(row.pid, identity)
        }
        if (additions.length) {
          const confirmation = members(await table())
          for (const row of additions) {
            if (!confirmation.some(current => current.pid === row.pid && current.ppid === row.ppid) ||
              await birth(row.pid) !== births.get(row.pid)) throw new Error('cleanup_unknown')
          }
        }
        if (stopping) {
          for (const [target, identity] of births) {
            if (!live.some(row => row.pid === target) || signalled.has(target)) continue
            if (!await sameBirth(target, identity)) continue
            cap()
            // Signals target captured births only, never a numeric group alone.
            try { ports.signal(target) } catch {
              if (ports.alive(target) !== 'gone') throw new Error('cleanup_unknown')
            }
            signalled.add(target)
          }
        }
        const survivors = [...births.keys()].filter(target => live.some(row => row.pid === target))
        if (closed && group.length === 0 && survivors.length === 0) {
          await boundOpenCodeRead(close, cap())
          await boundOpenCodeRead(Promise.allSettled([...pending]), cap())
          if (pending.size) throw new Error('cleanup_unknown')
          retired = true
          if (failure || !ended || code !== 0 || signal?.aborted) throw failure ?? new Error('selection_unavailable')
          return output
        }
        await ports.sleep(Math.min(25, cap()))
      }
    } catch (error) {
      if (!retired) throw new OpenCodeVersionProbeCleanupError(error, helperFailure)
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
