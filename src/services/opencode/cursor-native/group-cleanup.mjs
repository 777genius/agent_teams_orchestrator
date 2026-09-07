const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export function ownedGroupMembers(snapshot, record, excludeLeader = false) {
  const leader = snapshot.find(row => row.pid === record.pid)
  if (leader && leader.born !== record.born) throw new Error('Request owner identity changed')
  return snapshot.filter(row => (row.pgid === record.pid || (row.pid === record.pid && row.born === record.born))
    && (!excludeLeader || row.pid !== record.pid))
}

// A signal failure is not disappearance: retain it and observe until the deadline.
export async function cleanupGroup({ members, signalGroup, termMs = 700, killMs = 1500,
  now = Date.now, delay = pause }) {
  const signalErrors = []
  function signal(kind) {
    try { signalGroup(kind) }
    catch (error) {
      if (error.code !== 'EPERM') throw error
      signalErrors.push({ signal: kind, code: error.code })
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
  signal('SIGTERM')
  let remaining = await observe(termMs)
  const escalated = remaining.length > 0
  if (escalated) {
    signal('SIGKILL')
    remaining = await observe(killMs)
  }
  return { escalated, remaining, signalErrors }
}
