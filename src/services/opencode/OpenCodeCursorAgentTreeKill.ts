import { spawn } from 'node:child_process'
import path from 'node:path'
import { captureDarwinAuditIdentity, readProcessStartTimeMs, signalExpectedProcessStable, terminateExpectedProcessTreeStable } from '../../utils/processKill.js'

export type NativeRow = { pid: number; ppid: number }
export type CursorAgentNativePorts = {
  platform: NodeJS.Platform
  selfPid: number
  now: () => number
  birth: (pid: number, timeout: number) => Promise<number | null>
  /** macOS audit-token identity for this exact process incarnation. */
  auditIdentity: (pid: number, timeout: number) => Promise<string | null>
  tree: (timeout: number) => Promise<NativeRow[]>
  /**
   * Destructive signaling must keep the incarnation binding acquired by the
   * platform primitive (pidfd, audit token, or equivalent) through the
   * signal.  A numeric process.kill after an awaited birth/ancestry check is
   * not safe: the PID can be recycled in that window.
   */
  signalExact?: (
    pid: number,
    expectedBirth: number,
    expectedOsIdentity?: string,
    signal?: NodeJS.Signals,
  ) => Promise<boolean>
  alive: (pid: number) => 'alive' | 'gone' | 'unknown'
  /** An exact Job/OS-tree termination receipt; PID-only taskkill is forbidden. */
  terminateExactTree?: (pid: number, expectedBirth: number, timeout: number, expectedOsIdentity?: string) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
}

/** Errors do not prove a launched helper has exited: wait for close. */
export function query(command: string, args: string[], timeout: number,
  launch: typeof spawn = spawn): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    let failure: Error | undefined
    const stop = (error: Error) => {
      failure ??= error
      try { child.kill('SIGKILL') } catch (killError) {
        failure = killError instanceof Error ? killError : new Error(String(killError))
      }
    }
    const timer = setTimeout(() => stop(new Error('Native helper timed out')), timeout)
    child.stdout?.on('data', (data: Buffer | string) => {
      if (output.length > 4 * 1024 * 1024) return
      output += String(data)
      if (output.length > 4 * 1024 * 1024) stop(new Error('Native helper output exceeded limit'))
    })
    child.on('error', error => {
      failure ??= error
      // No PID means spawn failed, so no helper can execute later.
      if (child.pid === undefined) { clearTimeout(timer); reject(failure) }
    })
    child.once('close', code => {
      clearTimeout(timer)
      if (failure || code !== 0) reject(failure ?? new Error(`Native helper exited ${code}`))
      else resolve(output)
    })
  })
}

export function nativePorts(overrides: Partial<CursorAgentNativePorts> = {}): CursorAgentNativePorts {
  return {
    platform: process.platform, selfPid: process.pid, now: Date.now,
    birth: async (pid, timeout) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null
      if (process.platform === 'linux') return readProcessStartTimeMs(pid, 'linux', timeout)
      if (process.platform !== 'darwin' && process.platform !== 'win32') return null
      try {
        const output = process.platform === 'darwin'
          ? await query('ps', ['-p', String(pid), '-o', 'lstart='], timeout)
          : await query(path.win32.join(process.env.SystemRoot || 'C:\\Windows',
            'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-Command',
              `$ErrorActionPreference = "Stop"; $p = [System.Diagnostics.Process]::GetProcessById(${pid}); try { $p.StartTime.ToUniversalTime().ToString("o") } finally { $p.Dispose() }`], timeout)
        const value = Date.parse(output.trim())
        return Number.isFinite(value) ? value : null
      } catch { return null }
    },
    auditIdentity: async (pid, timeout) => {
      if (process.platform !== 'darwin' || !Number.isSafeInteger(pid) || pid <= 0) return null
      // The timeout is enforced by the caller's deadline. The native lookup is
      // deliberately acquired for each descendant, not inherited from root.
      if (timeout <= 0) return null
      return captureDarwinAuditIdentity(pid)
    },
    tree: async timeout => {
      const output = process.platform === 'win32'
        ? await query(path.win32.join(process.env.SystemRoot || 'C:\\Windows',
          'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.ParentProcessId }'], timeout)
        : await query('ps', ['-e', '-o', 'pid=', '-o', 'ppid='], timeout)
      const rows = output.trim().split('\n').filter(Boolean).map(line => {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
        if (!match) throw new Error('Unreadable process tree')
        return { pid: Number(match[1]), ppid: Number(match[2]) }
      })
      if (!rows.length) throw new Error('Empty process tree')
      return rows.filter(row => row.pid !== 0)
    },
    alive: pid => {
      try { process.kill(pid, 0); return 'alive' }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown' }
    },
    // On Linux pidfd_open binds the incarnation for the signal itself. macOS
    // must carry the audit identity captured at launch; a fresh audit token or
    // an epoch/birth comparison is not an identity for a reused PID.
    signalExact: async (pid, expectedBirth, expectedOsIdentity, signal = 'SIGKILL') => (process.platform === 'linux' || process.platform === 'darwin')
      && await signalExpectedProcessStable(pid, signal, expectedBirth,
        expectedOsIdentity ?? (process.platform === 'linux' ? `unix-pgid:${pid}` : undefined)),
    terminateExactTree: async (pid, expectedBirth, timeout, expectedOsIdentity) =>
      process.platform === 'win32' && await terminateExpectedProcessTreeStable(
        pid, 'SIGKILL', expectedBirth, expectedOsIdentity,
        { timeoutMs: timeout, escalationTimeoutMs: 0, pollMs: 25, platform: 'win32',
          nowMs: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
      ),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    ...overrides,
  }
}

export const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

export type TreeKillResult = { complete: boolean; killedPids: number[]; diagnostics: string[] }

export async function killCursorAgentTree(input: {
  pid: number; expectedBirth: number; deadline: number; guard: () => void
  protectedPids: ReadonlySet<number>
  expectedOsIdentity?: string
}, ports: CursorAgentNativePorts = nativePorts()): Promise<TreeKillResult> {
  const result: TreeKillResult = { complete: false, killedPids: [], diagnostics: [] }
  const frozen = new Map<number, number>()
  const auditIdentities = new Map<number, string>()
  let terminationComplete = false
  const check = () => {
    input.guard()
    if (ports.now() >= input.deadline) throw new Error('Tree termination deadline exhausted')
  }
  const remaining = () => { check(); return Math.max(1, Math.min(2000, input.deadline - ports.now())) }
  const identityFor = (pid: number) => ports.platform === 'darwin'
    ? auditIdentities.get(pid)
    : (pid === input.pid ? input.expectedOsIdentity : undefined)
  const birth = async (pid: number) => {
    const value = await ports.birth(pid, remaining())
    check()
    if (!positive(value)) throw new Error(`Unreadable native birth pid=${pid}`)
    return value
  }
  const captureAuditIdentity = async (pid: number, enforceAuthority = true): Promise<string | undefined> => {
    if (ports.platform !== 'darwin') return undefined
    // Rollback has to resume a process we already stopped even after the work
    // deadline has elapsed.  It still revalidates the exact audit identity;
    // only the expired work guard is bypassed for that non-destructive repair.
    const timeout = enforceAuthority ? remaining() : 2_000
    const value = await ports.auditIdentity(pid, timeout)
    if (enforceAuthority) check()
    if (!value?.startsWith('darwin-audit:')) throw new Error(`Unreadable native audit identity pid=${pid}`)
    const prior = auditIdentities.get(pid)
    if (prior !== undefined && prior !== value) throw new Error(`Reused native audit identity pid=${pid}`)
    auditIdentities.set(pid, value)
    return value
  }
  const signalCaptured = async (pid: number, expectedBirth: number, signal: NodeJS.Signals,
    enforceAuthority = true): Promise<boolean> => {
    // A descendant's audit token is captured while it is still in the
    // validated ancestry.  Re-read it at the signal edge solely to prove the
    // same incarnation remains, then pass that original identity to the
    // kernel-bound signal primitive.  Never authorize a replacement from a
    // token first observed after ancestry capture.
    const identity = identityFor(pid)
    if (ports.platform === 'darwin') {
      if (!identity) throw new Error(`Missing captured native audit identity pid=${pid}`)
      await captureAuditIdentity(pid, enforceAuthority)
    }
    if (enforceAuthority) check()
    return Boolean(await ports.signalExact?.(pid, expectedBirth, identity, signal))
  }
  try {
    check()
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0 || !positive(input.expectedBirth)
      || input.pid === ports.selfPid || input.protectedPids.has(input.pid)) {
      throw new Error('Protected or invalid root')
    }
    if (await birth(input.pid) !== input.expectedBirth) throw new Error('Root birth changed')
    if (ports.platform === 'darwin') {
      const rootAudit = await captureAuditIdentity(input.pid)
      if (rootAudit !== input.expectedOsIdentity) throw new Error('Root audit identity changed')
    }
    if (ports.platform === 'win32') {
      if (!ports.terminateExactTree) throw new Error('No incarnation-bound Windows tree terminator available')
      // Windows cannot safely exclude an ancestor using POSIX ps. Walk the
      // native process table before granting taskkill authority.
      const rows = await ports.tree(remaining())
      check()
      const tree = descendants(rows, input.pid)
      if (tree.some(row => row.pid === ports.selfPid || input.protectedPids.has(row.pid))) {
        throw new Error('Tree contains a protected process')
      }
      const captured = new Map<number, number>()
      for (const row of tree) {
        captured.set(row.pid, await birth(row.pid))
        await captureAuditIdentity(row.pid)
      }
      for (const row of tree) {
        const parentBirth = row.ppid === input.pid ? input.expectedBirth : captured.get(row.ppid)
        const childBirth = captured.get(row.pid)
        if (!positive(parentBirth) || !positive(childBirth) || childBirth < parentBirth) {
          throw new Error('Child predates captured parent generation')
        }
      }
      const confirmed = descendants(await ports.tree(remaining()), input.pid)
      check()
      if (tree.some(row =>
        !confirmed.some(current => current.pid === row.pid && current.ppid === row.ppid))) {
        throw new Error('Process ancestry changed during identity capture')
      }
      // A new child is not a replacement. Capture it before freezing so the
      // shutdown barrier includes work Cursor forked during enumeration.
      for (const row of confirmed) {
        if (captured.has(row.pid)) continue
        if (row.pid === ports.selfPid || input.protectedPids.has(row.pid)) throw new Error('Tree contains a protected process')
        const childBirth = await birth(row.pid)
        const parentBirth = row.ppid === input.pid ? input.expectedBirth : captured.get(row.ppid)
        if (!positive(parentBirth) || childBirth < parentBirth) throw new Error('Child predates captured parent generation')
        captured.set(row.pid, childBirth)
        await captureAuditIdentity(row.pid)
      }
      for (const [pid, value] of captured) if (await birth(pid) !== value) throw new Error(`Reused descendant pid=${pid}`)
      if (await birth(input.pid) !== input.expectedBirth) throw new Error('Root birth changed before taskkill')
      check()
      // Both the final live-context check and the signal operation are bound
      // to the exact tree primitive.  Do not replace this with taskkill /PID:
      // the root PID can be recycled after the ancestry reads above.
      if (!(await ports.terminateExactTree(input.pid, input.expectedBirth,
        Math.max(1, input.deadline - ports.now()), input.expectedOsIdentity))) {
        throw new Error('Exact Windows tree termination receipt unavailable')
      }
      check()
      await awaitGone(new Map([[input.pid, input.expectedBirth], ...captured]), ports, check, birth)
      result.killedPids.push(...captured.keys(), input.pid)
    } else if (ports.platform === 'linux' || ports.platform === 'darwin') {
      if (!ports.signalExact) throw new Error('No incarnation-bound native signal handle available')
      const rows = await ports.tree(remaining())
      check()
      const tree = descendants(rows, input.pid)
      if (tree.some(row => row.pid === ports.selfPid || input.protectedPids.has(row.pid))) {
        throw new Error('Tree contains a protected process')
      }
      const captured = new Map<number, number>()
      const capturedParents = new Map<number, number>()
      for (const row of tree) {
        captured.set(row.pid, await birth(row.pid))
        capturedParents.set(row.pid, row.ppid)
        // Bind every descendant before ancestry is accepted. A later audit
        // lookup alone could silently bind a recycled PID.
        await captureAuditIdentity(row.pid)
      }
      for (const row of tree) {
        const parentBirth = row.ppid === input.pid ? input.expectedBirth : captured.get(row.ppid)
        const childBirth = captured.get(row.pid)
        if (!positive(parentBirth) || !positive(childBirth) || childBirth < parentBirth) {
          throw new Error('Child predates captured parent generation')
        }
      }
      captured.set(input.pid, input.expectedBirth)
      const revalidateCapturedAncestry = async (pid: number, expectedBirth: number): Promise<void> => {
        const liveRows = await ports.tree(remaining())
        check()
        const live = descendants(liveRows, input.pid)
        if (pid === input.pid) {
          if (await birth(input.pid) !== input.expectedBirth) throw new Error('Root birth changed during ancestry revalidation')
          return
        }
        const expectedParent = capturedParents.get(pid)
        const current = live.find(row => row.pid === pid)
        if (expectedParent === undefined || !current || current.ppid !== expectedParent) {
          throw new Error(`Process ancestry changed around identity capture pid=${pid}`)
        }
        // Validate the complete route back to the root, not merely the child
        // edge. This prevents a newly discovered descendant from being
        // reparented through a recycled intermediate PID before SIGSTOP.
        const byPid = new Map(live.map(row => [row.pid, row]))
        let ancestor = current
        while (ancestor.ppid !== input.pid) {
          const parent = byPid.get(ancestor.ppid)
          const parentBirth = captured.get(ancestor.ppid)
          if (!parent || !positive(parentBirth) || await birth(ancestor.ppid) !== parentBirth) {
            throw new Error(`Process ancestry changed around identity capture pid=${pid}`)
          }
          ancestor = parent
        }
        if (await birth(pid) !== expectedBirth) throw new Error(`Reused descendant pid=${pid}`)
      }
      // A PID reused before its first birth read must still belong to the
      // same captured ancestry. Then recheck births around this second table.
      const confirmedRows = await ports.tree(remaining())
      check()
      const confirmed = descendants(confirmedRows, input.pid)
      if (tree.some(row =>
        !confirmed.some(current => current.pid === row.pid && current.ppid === row.ppid))) {
        throw new Error('Process ancestry changed during identity capture')
      }
      const initiallyPending = confirmed.filter(row => !captured.has(row.pid))
      while (initiallyPending.length) {
        const index = initiallyPending.findIndex(row => row.ppid === input.pid || captured.has(row.ppid))
        if (index < 0) throw new Error('New descendant ancestry could not be captured')
        const [row] = initiallyPending.splice(index, 1)
        if (row.pid === ports.selfPid || input.protectedPids.has(row.pid)) throw new Error('Tree contains a protected process')
        const childBirth = await birth(row.pid)
        const parentBirth = row.ppid === input.pid ? input.expectedBirth : captured.get(row.ppid)
        if (!positive(parentBirth) || childBirth < parentBirth) throw new Error('Child predates captured parent generation')
        captured.set(row.pid, childBirth)
        capturedParents.set(row.pid, row.ppid)
        await captureAuditIdentity(row.pid)
        await revalidateCapturedAncestry(row.pid, childBirth)
      }
      // Validate the complete captured set before the first destructive stage.
      for (const [pid, value] of captured) if (await birth(pid) !== value) throw new Error(`Reused process pid=${pid}`)
      // Freeze every known member, then repeatedly rescan its live ancestry.
      // This closes the child-spawn window between enumeration and SIGKILL:
      // a stopped Cursor root/parent cannot fork an unobserved descendant.
      for (let pass = 0; pass < 8; pass += 1) {
        for (const [pid, value] of captured) {
          if (frozen.has(pid)) continue
          check()
          // The process table is advisory, so revalidate the exact ancestry
          // after capturing identity and immediately before the freeze edge.
          // `signalExact` then carries that incarnation binding through the
          // actual signal instead of falling back to a numeric PID.
          await revalidateCapturedAncestry(pid, value)
          if (!(await signalCaptured(pid, value, 'SIGSTOP')))
            throw new Error(`Incarnation-bound freeze failed pid=${pid}`)
          frozen.set(pid, value)
        }
        const frozenRows = descendants(await ports.tree(remaining()), input.pid)
        check()
        // If later enumeration no longer reports one we stopped, it may
        // still be alive and frozen. Refuse to continue toward a successful
        // receipt; the catch compensation below resumes every exact frozen
        // handle, including this dropped member.
        for (const pid of frozen.keys()) {
          if (pid !== input.pid && !frozenRows.some(row => row.pid === pid)) {
            throw new Error(`Frozen process dropped from enumeration pid=${pid}`)
          }
        }
        const additions = frozenRows.filter(row => !captured.has(row.pid))
        if (additions.length === 0) {
          const ordered = new Map<number, number>()
          for (const row of frozenRows) ordered.set(row.pid, captured.get(row.pid) ?? await birth(row.pid))
          ordered.set(input.pid, input.expectedBirth)
          captured.clear()
          for (const [pid, value] of ordered) captured.set(pid, value)
          break
        }
        // descendants() is leaf-first for kill ordering. Capture additions
        // rootward instead so each child can validate the already-captured
        // full ancestry around its identity acquisition.
        const pending = [...additions]
        while (pending.length) {
          const index = pending.findIndex(row => row.ppid === input.pid || captured.has(row.ppid))
          if (index < 0) throw new Error('New descendant ancestry could not be captured')
          const [row] = pending.splice(index, 1)
          if (row.pid === ports.selfPid || input.protectedPids.has(row.pid)) throw new Error('Tree contains a protected process')
          const childBirth = await birth(row.pid)
          const parentBirth = row.ppid === input.pid ? input.expectedBirth : captured.get(row.ppid)
          if (!positive(parentBirth) || childBirth < parentBirth) throw new Error('Child predates captured parent generation')
          captured.set(row.pid, childBirth)
          capturedParents.set(row.pid, row.ppid)
          await captureAuditIdentity(row.pid)
          await revalidateCapturedAncestry(row.pid, childBirth)
        }
        if (pass === 7) throw new Error('Process tree kept changing while frozen')
      }
      for (const [pid, value] of captured) if (await birth(pid) !== value) throw new Error(`Reused frozen process pid=${pid}`)
      for (const [pid, value] of captured) {
        check()
        const rootState = ports.alive(input.pid)
        if (rootState === 'unknown') throw new Error('Root liveness unreadable')
        if (rootState === 'gone' && result.killedPids.length === 0) throw new Error('Root exited before termination')
        if (rootState === 'alive' && await birth(input.pid) !== input.expectedBirth) {
          throw new Error('Root birth changed during tree kill')
        }
        if (ports.alive(pid) === 'gone') continue
        if (await birth(pid) !== value) throw new Error(`Reused process pid=${pid}`)
        // `signalExact` owns the identity binding for the entire operation.
        // Rechecking right beside it stops an aborted/deadline-exhausted reaper
        // from signaling a still-valid handle after authority has ended.
        check()
        if (!(await signalCaptured(pid, value, 'SIGKILL'))) {
          throw new Error(`Incarnation-bound signal failed pid=${pid}`)
        }
        check()
        result.killedPids.push(pid)
      }
      await awaitGone(captured, ports, check, birth)
    } else throw new Error('Unsupported native identity platform')
    // Require repeated post-signal scans. A Cursor child may be forked while
    // the root is being stopped; a captured-set-only receipt would miss it.
    for (let scan = 0; scan < 2; scan += 1) {
      check()
      const rows = await ports.tree(remaining())
      check()
      const surviving = rows.filter(row => (row.pid === input.pid || result.killedPids.includes(row.pid)) && ports.alive(row.pid) !== 'gone')
      if (surviving.length > 0) throw new Error('Owned process remains after signal')
      if (scan === 0) await ports.sleep(25)
    }
    terminationComplete = true
    result.diagnostics.push('Repeated post-signal process scans were quiescent')
    result.complete = true
  } catch (error) {
    // Freezing is only an intermediate containment measure. If termination
    // did not start, resume every exact handle so an aborted reconciliation
    // cannot strand a live owned agent in SIGSTOP.
    if (!terminationComplete) {
      for (const [pid, value] of frozen) {
        // SIGCONT is compensation for our own temporary SIGSTOP, not more
        // work. It deliberately bypasses an expired/cancelled work guard but
        // keeps the original incarnation binding and Darwin revalidation.
        try { await signalCaptured(pid, value, 'SIGCONT', false) } catch {}
      }
    }
    result.diagnostics.push(error instanceof Error ? error.message : String(error))
  }
  return result
}

function descendants(rows: NativeRow[], root: number): NativeRow[] {
  const seen = new Set<number>()
  for (const row of rows) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.ppid)
      || row.ppid < 0 || seen.has(row.pid)) throw new Error('Conflicting process tree')
    seen.add(row.pid)
  }
  if (!seen.has(root)) throw new Error('Root absent from process tree')
  const ordered: NativeRow[] = []
  const visiting = new Set([root])
  const walk = (pid: number) => {
    for (const row of rows.filter(row => row.ppid === pid)) {
      if (visiting.has(row.pid) || visiting.size > 4096) throw new Error('Cyclic or oversized process tree')
      visiting.add(row.pid)
      walk(row.pid)
      ordered.push(row)
    }
  }
  walk(root)
  return ordered
}

async function awaitGone(captured: Map<number, number>, ports: CursorAgentNativePorts,
  check: () => void, birth: (pid: number) => Promise<number>): Promise<void> {
  const pending = new Map(captured)
  while (pending.size) {
    for (const [pid, expected] of pending) {
      check()
      const state = ports.alive(pid)
      if (state === 'gone') { pending.delete(pid); continue }
      if (state === 'unknown') throw new Error(`Unreadable process liveness pid=${pid}`)
      if (await birth(pid) !== expected) throw new Error(`Reused process after signal pid=${pid}`)
    }
    if (pending.size) { check(); await ports.sleep(25) }
  }
}
