const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export const SCOPE_VARIABLE = 'CURSOR_OWNER_SCOPE'

/**
 * Exec-time environment is inherited by every descendant across languages and
 * survives setsid, double forks and reparenting to pid 1, so a request-unique
 * marker identifies survivors that process-group ownership alone cannot reach.
 * Only pids leave this module: descendant environments contain foreign secrets.
 */
export function scopeMarkedPids({ scopeId, snapshot, self = process.pid, exclude = [] }) {
  if (typeof scopeId !== 'string' || !/^[a-f0-9]{32}$/.test(scopeId)) {
    throw new Error('Scope sweep requires a request-unique marker')
  }
  const marker = `${SCOPE_VARIABLE}=${scopeId}`
  const skip = new Set([self, ...exclude])
  const pids = []
  for (const line of snapshot.split('\n')) {
    if (!line.includes(marker)) continue
    const pid = Number.parseInt(line, 10)
    if (Number.isSafeInteger(pid) && pid > 1 && !skip.has(pid)) pids.push(pid)
  }
  return [...new Set(pids)]
}

/**
 * Terminates marked survivors individually: they no longer share a group with
 * anything this owner created, and signalling their groups could reach foreign
 * processes that merely adopted a reused group identity.
 */
export async function sweepScope({ members, signalPid, termMs = 700, killMs = 1500,
  now = Date.now, delay = pause }) {
  const signalErrors = []
  const terminated = new Set()
  function signal(pids, kind) {
    for (const pid of pids) {
      terminated.add(pid)
      try { signalPid(pid, kind) }
      catch (error) {
        if (error.code === 'ESRCH') continue
        if (error.code !== 'EPERM') throw error
        signalErrors.push({ pid, signal: kind, code: error.code })
      }
    }
  }
  async function observe(duration) {
    const deadline = now() + duration
    let remaining = members()
    while (remaining.length && now() < deadline) {
      await delay(40)
      remaining = members()
    }
    return remaining
  }
  let remaining = members()
  if (remaining.length === 0) return { escalated: false, terminated: [], remaining: [], signalErrors }
  signal(remaining, 'SIGTERM')
  remaining = await observe(termMs)
  const escalated = remaining.length > 0
  if (escalated) {
    signal(remaining, 'SIGKILL')
    remaining = await observe(killMs)
  }
  return { escalated, terminated: [...terminated], remaining, signalErrors }
}
