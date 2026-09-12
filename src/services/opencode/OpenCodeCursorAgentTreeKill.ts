import { spawn } from 'node:child_process'
import path from 'node:path'
import { readProcessStartTimeMs } from '../../utils/processKill.js'

export type NativeRow = { pid: number; ppid: number }
export type CursorAgentNativePorts = {
  platform: NodeJS.Platform
  selfPid: number
  now: () => number
  birth: (pid: number, timeout: number) => Promise<number | null>
  tree: (timeout: number) => Promise<NativeRow[]>
  signal: (pid: number) => void
  alive: (pid: number) => 'alive' | 'gone' | 'unknown'
  taskkill: (pid: number, timeout: number) => Promise<void>
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
    signal: pid => { process.kill(pid, 'SIGKILL') },
    alive: pid => {
      try { process.kill(pid, 0); return 'alive' }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown' }
    },
    taskkill: async (pid, timeout) => {
      const command = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      await query(command, ['/PID', String(pid), '/T', '/F'], timeout)
    },
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
}, ports: CursorAgentNativePorts = nativePorts()): Promise<TreeKillResult> {
  const result: TreeKillResult = { complete: false, killedPids: [], diagnostics: [] }
  const check = () => {
    input.guard()
    if (ports.now() >= input.deadline) throw new Error('Tree termination deadline exhausted')
  }
  const remaining = () => { check(); return Math.max(1, Math.min(2000, input.deadline - ports.now())) }
  const birth = async (pid: number) => {
    const value = await ports.birth(pid, remaining())
    check()
    if (!positive(value)) throw new Error(`Unreadable native birth pid=${pid}`)
    return value
  }
  try {
    check()
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0 || !positive(input.expectedBirth)
      || input.pid === ports.selfPid || input.protectedPids.has(input.pid)) {
      throw new Error('Protected or invalid root')
    }
    if (await birth(input.pid) !== input.expectedBirth) throw new Error('Root birth changed')
    if (ports.platform === 'win32') {
      // Windows cannot safely exclude an ancestor using POSIX ps. Walk the
      // native process table before granting taskkill authority.
      const rows = await ports.tree(remaining())
      check()
      const tree = descendants(rows, input.pid)
      if (tree.some(row => row.pid === ports.selfPid || input.protectedPids.has(row.pid))) {
        throw new Error('Tree contains a protected process')
      }
      const captured = new Map<number, number>()
      for (const row of tree) captured.set(row.pid, await birth(row.pid))
      for (const row of tree) {
        const parentBirth = row.ppid === input.pid ? input.expectedBirth : captured.get(row.ppid)
        const childBirth = captured.get(row.pid)
        if (!positive(parentBirth) || !positive(childBirth) || childBirth < parentBirth) {
          throw new Error('Child predates captured parent generation')
        }
      }
      const confirmed = descendants(await ports.tree(remaining()), input.pid)
      check()
      if (confirmed.length !== tree.length || tree.some(row =>
        !confirmed.some(current => current.pid === row.pid && current.ppid === row.ppid))) {
        throw new Error('Process ancestry changed during identity capture')
      }
      for (const [pid, value] of captured) if (await birth(pid) !== value) throw new Error(`Reused descendant pid=${pid}`)
      if (await birth(input.pid) !== input.expectedBirth) throw new Error('Root birth changed before taskkill')
      check()
      await ports.taskkill(input.pid, Math.max(1, input.deadline - ports.now()))
      check()
      await awaitGone(new Map([[input.pid, input.expectedBirth], ...captured]), ports, check, birth)
      result.killedPids.push(...captured.keys(), input.pid)
    } else if (ports.platform === 'linux' || ports.platform === 'darwin') {
      const rows = await ports.tree(remaining())
      check()
      const tree = descendants(rows, input.pid)
      if (tree.some(row => row.pid === ports.selfPid || input.protectedPids.has(row.pid))) {
        throw new Error('Tree contains a protected process')
      }
      const captured = new Map<number, number>()
      for (const row of tree) captured.set(row.pid, await birth(row.pid))
      for (const row of tree) {
        const parentBirth = row.ppid === input.pid ? input.expectedBirth : captured.get(row.ppid)
        const childBirth = captured.get(row.pid)
        if (!positive(parentBirth) || !positive(childBirth) || childBirth < parentBirth) {
          throw new Error('Child predates captured parent generation')
        }
      }
      captured.set(input.pid, input.expectedBirth)
      // A PID reused before its first birth read must still belong to the
      // same captured ancestry. Then recheck births around this second table.
      const confirmedRows = await ports.tree(remaining())
      check()
      const confirmed = descendants(confirmedRows, input.pid)
      if (confirmed.length !== tree.length || tree.some(row =>
        !confirmed.some(current => current.pid === row.pid && current.ppid === row.ppid))) {
        throw new Error('Process ancestry changed during identity capture')
      }
      // Validate the complete captured set before the first destructive stage.
      for (const [pid, value] of captured) if (await birth(pid) !== value) throw new Error(`Reused process pid=${pid}`)
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
        check()
        ports.signal(pid)
        result.killedPids.push(pid)
      }
      await awaitGone(captured, ports, check, birth)
    } else throw new Error('Unsupported native identity platform')
    // Completion covers the identity-checked captured set, not containment of
    // arbitrary children that detached before enumeration.
    result.diagnostics.push('Captured process set terminated; detached descendants are not proven absent')
    result.complete = true
  } catch (error) {
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
