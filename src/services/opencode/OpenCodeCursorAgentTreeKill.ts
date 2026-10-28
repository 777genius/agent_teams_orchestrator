import { spawn } from 'node:child_process'
import path from 'node:path'
import { readProcessStartTimeMs } from '../../utils/processKill.js'
import { windowsNativeProcess } from '../../utils/windowsNativeProcess.js'

export type NativeRow = { pid: number; ppid: number }
export type NativeGeneration = Readonly<NativeRow & { birth: number }>
export type CursorAgentNativePorts = {
  platform: NodeJS.Platform
  selfPid: number
  now: () => number
  birth: (pid: number, timeout: number) => Promise<number | null>
  tree: (timeout: number) => Promise<NativeRow[]>
  /** Read-only pre-spawn witness; unavailable backends grant no exclusions. */
  existingWindows?: (deadline: number) => Promise<readonly NativeGeneration[] | null>
  /** Native metadata only: independently confirm the protected generations. */
  protectedWindows?: (deadline: number) => Promise<readonly NativeGeneration[] | null>
  signal: (pid: number) => void
  alive: (pid: number) => 'alive' | 'gone' | 'unknown'
  taskkill: (pid: number, timeout: number) => Promise<void>
  sleep: (ms: number) => Promise<void>
}

export type NativeHelperCause = Readonly<{
  stage: 'process_lookup' | 'start_time'
  category: 'ArgumentException' | 'InvalidOperationException' | 'Win32Exception' | 'UnauthorizedAccessException' | 'other'
  hresult: number
  nativeErrorCode: number | null
}>

function parseHelperCause(line: string): NativeHelperCause | undefined {
  const prefix = 'native-helper-cause:'
  if (!line.startsWith(prefix)) return undefined
  try {
    const value: unknown = JSON.parse(line.slice(prefix.length))
    if (!value || typeof value !== 'object' || !('stage' in value) || !('category' in value)
      || !('hresult' in value) || !('nativeErrorCode' in value)) return undefined
    const { stage, category, hresult, nativeErrorCode } = value
    if (stage !== 'process_lookup' && stage !== 'start_time') return undefined
    if (category !== 'ArgumentException' && category !== 'InvalidOperationException'
      && category !== 'Win32Exception' && category !== 'UnauthorizedAccessException' && category !== 'other') return undefined
    const integer = (field: unknown): field is number => typeof field === 'number'
      && Number.isInteger(field) && field >= -0x80000000 && field <= 0x7fffffff
    if (!integer(hresult) || (nativeErrorCode !== null && !integer(nativeErrorCode))) return undefined
    return { stage, category, hresult, nativeErrorCode }
  } catch { return undefined }
}

class NativeHelperQueryError extends Error {
  constructor(code: number | null, readonly helperCause?: NativeHelperCause) {
    super(`Native helper exited ${code}`)
  }
}

/** Errors do not prove a launched helper has exited: wait for close. */
export function query(command: string, args: string[], timeout: number,
  launch: typeof spawn = spawn, captureHelperCause = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', captureHelperCause ? 'pipe' : 'ignore'] })
    let output = ''
    let helperCause: NativeHelperCause | undefined
    let diagnosticOutput = '', diagnosticBytes = 0
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
    child.stderr?.on('data', (data: Buffer | string) => {
      if (!captureHelperCause || diagnosticBytes >= 1024 || helperCause) return
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const bounded = bytes.subarray(0, 1024 - diagnosticBytes)
      diagnosticBytes += bounded.byteLength
      diagnosticOutput += bounded.toString('utf8')
      for (const line of diagnosticOutput.split(/\r?\n/)) helperCause ??= parseHelperCause(line)
    })
    child.on('error', error => {
      failure ??= error
      // No PID means spawn failed, so no helper can execute later.
      if (child.pid === undefined) { clearTimeout(timer); reject(failure) }
    })
    child.once('close', code => {
      clearTimeout(timer)
      if (failure || code !== 0) reject(failure ?? new NativeHelperQueryError(code, helperCause))
      else resolve(output)
    })
  })
}

export type NativeHelperFailure = Readonly<{
  operation: 'birth' | 'tree'
  reason: 'helper_timeout' | 'helper_nonzero' | 'helper_spawn_error' | 'helper_output_limit' | 'helper_error'
  exitCode: number | null
  elapsedMs: number
  helperCause?: NativeHelperCause
}>

export function classifyNativeHelperFailure(operation: NativeHelperFailure['operation'], error: unknown,
  elapsedMs: number): NativeHelperFailure {
  const message = error instanceof Error ? error.message : ''
  const exit = /^Native helper exited (-?\d+)$/.exec(message)
  const reason: NativeHelperFailure['reason'] = message === 'Native helper timed out' ? 'helper_timeout'
    : exit ? 'helper_nonzero' : message === 'Native helper output exceeded limit' ? 'helper_output_limit'
      : error instanceof Error && 'code' in error ? 'helper_spawn_error' : 'helper_error'
  return { operation, reason, exitCode: exit ? Number(exit[1]) : null, elapsedMs: Math.max(0, elapsedMs),
    ...(error instanceof NativeHelperQueryError && error.helperCause ? { helperCause: error.helperCause } : {}) }
}

// PowerShell's command-line parser does not consume libuv's backslash-escaped
// embedded quotes. Encoding transports the exact script without a second parse.
function windowsPowerShellArguments(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

export function nativePorts(overrides: Partial<CursorAgentNativePorts> = {},
  onHelperFailure?: (failure: NativeHelperFailure) => void): CursorAgentNativePorts {
  const observedQuery = async (operation: NativeHelperFailure['operation'], command: string, args: string[], timeout: number) => {
    const started = Date.now()
    try { return await query(command, args, timeout, spawn, operation === 'birth' && process.platform === 'win32') }
    catch (error) {
      onHelperFailure?.(classifyNativeHelperFailure(operation, error, Date.now() - started))
      throw error
    }
  }
  return {
    platform: process.platform, selfPid: process.pid, now: Date.now,
    protectedWindows: async deadline => {
      if (process.platform !== 'win32') return null
      const kernel32 = await windowsNativeProcess()
      if (!kernel32) return null
      const cap = () => { if (Date.now() >= deadline) throw new Error('Native witness deadline exhausted') }
      const table = () => {
        cap()
        const rows = kernel32.table(), seen = new Set<number>()
        if (rows.length > 4096) throw new Error('Oversized native witness')
        for (const row of rows) {
          if (!Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.ppid)
            || row.ppid < 0 || seen.has(row.pid)) throw new Error('Unreadable native witness')
          seen.add(row.pid)
        }
        cap()
        return rows
      }
      const protectedPids = new Set([process.pid, process.ppid].filter(pid => pid > 0))
      const captured: NativeGeneration[] = []
      for (const row of table()) if (protectedPids.has(row.pid)) {
        cap()
        const birth = kernel32.birth(row.pid)
        cap()
        if (positive(birth)) captured.push({ ...row, birth })
      }
      const confirmed = table(), result: NativeGeneration[] = []
      for (const row of captured) {
        cap()
        if (!confirmed.some(current => current.pid === row.pid && current.ppid === row.ppid)) continue
        const birth = kernel32.birth(row.pid)
        cap()
        if (birth === row.birth) result.push(row)
      }
      return result
    },
    existingWindows: async deadline => {
      if (process.platform !== 'win32') return null
      // Never turn this optional proof into N cold PowerShell starts. Native
      // reads close every handle and are bounded by the original probe clock.
      const kernel32 = await windowsNativeProcess()
      if (!kernel32) return null
      const cap = () => { if (Date.now() >= deadline) throw new Error('Native witness deadline exhausted') }
      const table = () => {
        cap()
        const rows = kernel32.table(), seen = new Set<number>()
        if (rows.length > 4096) throw new Error('Oversized native witness')
        for (const row of rows) {
          if (!Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.ppid)
            || row.ppid < 0 || seen.has(row.pid)) throw new Error('Unreadable native witness')
          seen.add(row.pid)
        }
        cap()
        return rows
      }
      const captured: NativeGeneration[] = []
      for (const row of table()) {
        cap()
        if (!row.pid || row.pid === process.pid || row.pid === process.ppid) continue
        const birth = kernel32.birth(row.pid)
        cap()
        if (positive(birth)) captured.push({ ...row, birth })
      }
      const confirmed = table(), result: NativeGeneration[] = []
      for (const row of captured) {
        cap()
        if (!confirmed.some(current => current.pid === row.pid && current.ppid === row.ppid)) continue
        const birth = kernel32.birth(row.pid)
        cap()
        if (birth === row.birth) result.push(row)
      }
      return result
    },
    birth: async (pid, timeout) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null
      if (process.platform === 'linux') return readProcessStartTimeMs(pid, 'linux', timeout)
      if (process.platform !== 'darwin' && process.platform !== 'win32') return null
      const kernel32 = process.platform === 'win32' ? await windowsNativeProcess() : null
      try {
        if (kernel32) return kernel32.birth(pid)
        const output = process.platform === 'darwin'
          ? await observedQuery('birth', 'ps', ['-p', String(pid), '-o', 'lstart='], timeout)
          : await observedQuery('birth', path.win32.join(process.env.SystemRoot || 'C:\\Windows',
            'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            windowsPowerShellArguments(
              `$ErrorActionPreference = "Stop"; $p = $null; $stage = 'process_lookup';
try {
  $p = [System.Diagnostics.Process]::GetProcessById(${pid});
  $stage = 'start_time'; $p.StartTime.ToUniversalTime().ToString("o")
} catch {
  $cause = $_.Exception.GetBaseException();
  $category = switch ($cause.GetType().Name) {
    'ArgumentException' { 'ArgumentException' }
    'InvalidOperationException' { 'InvalidOperationException' }
    'Win32Exception' { 'Win32Exception' }
    'UnauthorizedAccessException' { 'UnauthorizedAccessException' }
    default { 'other' }
  };
  $nativeCode = 'null';
  if ($cause -is [System.ComponentModel.Win32Exception]) { $nativeCode = $cause.NativeErrorCode.ToString([System.Globalization.CultureInfo]::InvariantCulture) };
  [Console]::Error.WriteLine('native-helper-cause:{"stage":"' + $stage + '","category":"' + $category + '","hresult":' + $cause.HResult.ToString([System.Globalization.CultureInfo]::InvariantCulture) + ',"nativeErrorCode":' + $nativeCode + '}');
  exit 1
} finally { if ($null -ne $p) { $p.Dispose() } }`), timeout)
        const value = Date.parse(output.trim())
        return Number.isFinite(value) ? value : null
      } catch { return null }
    },
    tree: async timeout => {
      // Each PowerShell/WMI helper below is a cold process start, seconds on a
      // busy host. The shipped Bun 1.3.11 has no bun:ffi dlopen on Windows ARM64
      // (TinyCC is disabled before 1.4.0), so only those hosts still use them.
      // Remove the Windows helpers once scripts/runtime-bun-pins.json ships Bun
      // 1.4.0 or newer for every Windows target.
      const kernel32 = process.platform === 'win32' ? await windowsNativeProcess() : null
      if (kernel32) return kernel32.table().filter(row => row.pid !== 0)
      const output = process.platform === 'win32'
        ? await observedQuery('tree', path.win32.join(process.env.SystemRoot || 'C:\\Windows',
          'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          windowsPowerShellArguments(
            // Avoid loading CimCmdlets in the private Windows environment.
            // Keep the same PID/parent projection and dispose every WMI resource.
            `$ErrorActionPreference = 'Stop';
[void][System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');
$searcher = [System.Management.ManagementObjectSearcher]::new('SELECT ProcessId, ParentProcessId FROM Win32_Process');
$results = $null;
try {
  $results = $searcher.Get();
  foreach ($row in $results) {
    try { [Console]::Out.WriteLine('{0} {1}', $row.GetPropertyValue('ProcessId'), $row.GetPropertyValue('ParentProcessId')) }
    finally { $row.Dispose() }
  }
} finally { if ($null -ne $results) { $results.Dispose() }; $searcher.Dispose() }`), timeout)
        : await observedQuery('tree', 'ps', ['-e', '-o', 'pid=', '-o', 'ppid='], timeout)
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
