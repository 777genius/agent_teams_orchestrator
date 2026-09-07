#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { cleanupGroup, ownedGroupMembers } from './group-cleanup.mjs'
import { SCOPE_VARIABLE, scopeMarkedPids, sweepScope } from './scope-sweep.mjs'
const root = import.meta.dirname
const [executable, ...args] = process.argv.slice(2)
if (!executable || process.platform !== 'darwin') process.exit(64)
const scope = mkdtempSync('/tmp/cursor-request-owned-')
chmodSync(scope, 0o700)
const socketPath = scope + '/owner.sock', token = randomBytes(24).toString('hex')
const scopeId = randomBytes(16).toString('hex')
const parent = process.ppid, records = new Map(), peers = new Set(), jobs = new Set()
const events = [], reportPath = process.env.CURSOR_SUPERVISOR_REPORT
const requestId = process.env.CURSOR_OWNER_REQUEST_ID || null
let native, nativeIdentity, stopping, parentTimer, nativeCode = null, nativeSignal = null
function rows() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8', timeout: 1000 })
    .trim().split('\n').map(line => {
      const [pid, ppid, pgid, state, ...born] = line.trim().split(/\s+/)
      return { pid: +pid, ppid: +ppid, pgid: +pgid, state, born: born.join(' ') }
    }).filter(x => !x.state.startsWith('Z'))
}
function signal(pid, kind) {
  try { process.kill(pid, kind) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
// Marked descendants only. The snapshot carries foreign environments, so it is
// reduced to pids inside this call and never retained, reported or logged.
function scopeSurvivors() {
  const snapshot = execFileSync('/bin/ps', ['-Eww', '-ax', '-o', 'pid=,command='],
    { encoding: 'utf8', timeout: 4000, maxBuffer: 64 * 1024 * 1024, env: { PATH: '/bin:/usr/bin' } })
  // The marker itself proves ownership, so a recycled pid can never be matched.
  return scopeMarkedPids({ scopeId, snapshot })
}
function groupRows(record, excludeLeader = false) {
  return ownedGroupMembers(rows(), record, excludeLeader)
}
async function clean(record, excludeLeader = false) {
  return cleanupGroup({
    members: () => groupRows(record, excludeLeader),
    signalGroup: kind => {
      if (excludeLeader) {
        // Live sentinel reserves the group identity; only its verified members are signalled.
        for (const row of groupRows(record, true)) signal(row.pid, kind)
      } else {
        if (groupRows(record).length === 0) return
        signal(-record.pid, kind)
        const leader = rows().find(x => x.pid === record.pid && x.born === record.born)
        if (leader && leader.pgid !== record.pid) signal(record.pid, kind)
      }
    },
  })
}
function track(work) { jobs.add(work); void work.then(() => jobs.delete(work), () => jobs.delete(work)); return work }
const server = createServer(peer => {
  peers.add(peer)
  let data = '', record
  peer.on('error', () => {})
  peer.on('data', chunk => {
    data += chunk.toString()
    if (data.length > 512) { peer.destroy(); return }
    const newline = data.indexOf('\n')
    if (newline < 0) return
    const line = data.slice(0, newline); data = data.slice(newline + 1)
    if (!record) {
      const [secret, pid, ppid, extra] = line.split(' ')
      if (stopping || secret !== token || extra || !/^\d+$/.test(pid || '')) { peer.destroy(); return }
      let identity
      try { identity = rows().find(x => x.pid === +pid && x.ppid === +ppid && x.pgid === nativeIdentity?.pid) }
      catch { peer.destroy(); void stop('registration-identity-failed', 70); return }
      if (!identity || records.has(+pid)) { peer.destroy(); return }
      record = { ...identity, peer }
      records.set(record.pid, record)
      events.push({ type: 'registered-before-release', ...identity })
      // Registration and release are synchronous in this event turn. Stop cannot interleave.
      peer.write('GO\n')
    } else if (line === 'DONE' && !stopping) {
      const current = record
      track(clean(current, true).then(result => {
        if (result.remaining.length) { void stop('orphan-cleanup-failed', 70); return }
        if (!stopping) peer.write('EXIT\n')
      }).catch(() => { void stop('orphan-cleanup-failed', 70) }))
    } else peer.destroy()
  })
  peer.on('close', () => {
    peers.delete(peer)
    if (record && !stopping) {
      const current = record
      // EOF never releases ownership: remove only after the entire group is gone.
      track(clean(current).then(result => {
        if (result.remaining.length) { void stop('owner-eof-cleanup-failed', 70); return }
        records.delete(current.pid)
      }).catch(() => { void stop('owner-eof-cleanup-failed', 70) }))
    }
  })
})
async function cleanup(reason, exitCode) {
  clearInterval(parentTimer)
  const failures = [], results = []
  const attempt = async (phase, work) => {
    try { await work() } catch (error) { failures.push({ phase, error: error.code || error.message }) }
  }
  // Unregistered gates have not called setsid: root-group cancellation contains them.
  await attempt('root-term', async () => {
    if (native?.pid && !nativeIdentity) throw new Error('Root identity was not observed')
    if (nativeIdentity && groupRows(nativeIdentity).length) {
      try { signal(-nativeIdentity.pid, 'SIGTERM') } catch (error) { if (error.code !== 'EPERM') throw error }
    }
  })
  await Promise.all([...records.values()].map(record => attempt(`group-${record.pid}`, async () => {
    results.push({ pid: record.pid, ...await clean(record) })
  })))
  if (nativeIdentity) await attempt('root-cleanup', async () => {
    results.push({ pid: nativeIdentity.pid, ...await clean(nativeIdentity) })
  })
  await Promise.allSettled([...jobs])
  for (const peer of peers) peer.destroy()
  await attempt('server-close', async () => { server.close() })
  // Group ownership cannot reach a descendant that made its own session, so the
  // inherited scope marker closes the demonstrated nested detach escape.
  let sweep = { escalated: false, terminated: [], remaining: [], signalErrors: [] }
  await attempt('scope-sweep', async () => {
    sweep = await sweepScope({ members: scopeSurvivors, signalPid: signal })
  })
  let remaining = []
  await attempt('final-identity-check', async () => {
    const snapshot = rows()
    remaining = [...(nativeIdentity ? ownedGroupMembers(snapshot, nativeIdentity) : []),
      ...[...records.values()].flatMap(record => ownedGroupMembers(snapshot, record))]
  })
  const scopeRemaining = sweep.remaining
  const report = { version: 1, kind: 'request-owned-preexec-barrier', requestId, supervisorPid: process.pid, nativePid: native?.pid,
    nativeCode, nativeSignal, reason,
    cleanupCompleted: failures.length === 0 && remaining.length === 0 && scopeRemaining.length === 0,
    containment: 'owned-groups-and-scope-marked-descendants',
    scopeSweep: { escalated: sweep.escalated, terminated: sweep.terminated, remaining: scopeRemaining, signalErrors: sweep.signalErrors },
    events, results, failures, remaining,
    limitations: ['macOS current-arch prototype', 'HTTP abort requires separate cleanup ACK',
      `a descendant that re-execs without ${SCOPE_VARIABLE} is not tracked`] }
  await attempt('report-write', async () => {
    if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
  })
  await attempt('scope-remove', async () => { rmSync(scope, { recursive: true, force: true }) })
  process.exit(report.cleanupCompleted && failures.length === 0 ? exitCode : 70)
}
function stop(reason, exitCode) {
  if (!stopping) stopping = Promise.resolve().then(() => cleanup(reason, exitCode))
  return stopping
}
process.on('SIGTERM', () => void stop('SIGTERM', 143))
process.on('SIGINT', () => void stop('SIGINT', 130))
process.on('SIGHUP', () => void stop('SIGHUP', 129))
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Owner socket startup deadline')), 3000)
    const failed = error => { clearTimeout(timeout); reject(error) }
    server.once('error', failed)
    server.listen(socketPath, () => { clearTimeout(timeout); server.off('error', failed); resolve() })
  })
} catch { await stop('control-startup-failed', 70); process.exit(70) }
server.on('error', () => { void stop('control-server-failed', 70) })
if (stopping) { await stopping; process.exit(143) }
const nativeEnv = { ...process.env }
delete nativeEnv.CURSOR_SUPERVISOR_REPORT
native = spawn(executable, args, { detached: true, stdio: 'inherit', env: {
  ...nativeEnv, [SCOPE_VARIABLE]: scopeId,
  CURSOR_OWNER_SOCKET: socketPath, CURSOR_OWNER_TOKEN: token,
  CURSOR_OWNER_GATE: root + '/gate', CURSOR_OWNER_NODE_OPTIONS: process.env.NODE_OPTIONS || '',
  NODE_OPTIONS: `--require=${JSON.stringify(root + '/preload.cjs')} ${process.env.NODE_OPTIONS || ''}`,
} })
// Capture the direct child's birth identity before yielding to any IPC or signal callback.
try { nativeIdentity = rows().find(row => row.pid === native.pid) }
catch { /* Unknown ownership fails closed below; never signal an unverified reused group. */ }
native.on('error', () => void stop('spawn-error', 127))
native.on('exit', (code, sig) => { nativeCode = code; nativeSignal = sig; void stop('native-exit', code ?? 1) })
if (native.pid && !nativeIdentity) void stop('root-identity-unavailable', 70)
parentTimer = setInterval(() => { if (process.ppid !== parent) void stop('parent-exit', 143) }, 100)
