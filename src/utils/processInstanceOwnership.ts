import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'

/** A PID is not an ownership token: operating systems reuse it.  Linux
 * starttime identifies an incarnation; platforms without that proof retain a
 * live PID conservatively. */
export type ProcessInstanceOwner = { pid: number; instance: string | null; active: boolean }

function startTime(stat: string): string | null {
  const close = stat.lastIndexOf(')')
  const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/)
  return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null
}

export async function processInstance(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (process.platform === 'linux') {
    try { return startTime(await readFile(`/proc/${pid}/stat`, 'utf8')) } catch { return null }
  }
  if (process.platform !== 'win32') return null
  // Get-Process.StartTime is backed by the native process creation time.  A
  // PID alone is never an incarnation proof on Windows, where it can be
  // recycled immediately after a child exits.
  const script = `$ErrorActionPreference='Stop';[Console]::Out.Write((Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToFileTimeUtc())`
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.once('error', () => resolve(null))
    child.once('close', code => resolve(code === 0 && /^\d+$/.test(output.trim()) ? output.trim() : null))
  })
}

export function processInstanceSync(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (process.platform === 'linux') {
    try { return startTime(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return null }
  }
  if (process.platform !== 'win32') return null
  const script = `$ErrorActionPreference='Stop';[Console]::Out.Write((Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToFileTimeUtc())`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const output = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  return !result.error && result.status === 0 && /^\d+$/.test(output) ? output : null
}

/** True means do not collect. False is returned only for a recorded inactive
 * writer, ESRCH, or a verified PID-incarnation mismatch. */
export async function isProcessInstanceActive(owner: ProcessInstanceOwner): Promise<boolean> {
  if (!owner.active || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
  try { process.kill(owner.pid, 0) } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  const observed = await processInstance(owner.pid)
  return owner.instance === null || observed === null || owner.instance === observed
}

export function isProcessInstanceActiveSync(owner: ProcessInstanceOwner): boolean {
  if (!owner.active || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
  try { process.kill(owner.pid, 0) } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  const observed = processInstanceSync(owner.pid)
  return owner.instance === null || observed === null || owner.instance === observed
}
