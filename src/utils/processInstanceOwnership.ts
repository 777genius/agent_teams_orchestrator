import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

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
  if (process.platform !== 'linux') return null
  try { return startTime(await readFile(`/proc/${pid}/stat`, 'utf8')) } catch { return null }
}

export function processInstanceSync(pid: number): string | null {
  if (process.platform !== 'linux') return null
  try { return startTime(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return null }
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
