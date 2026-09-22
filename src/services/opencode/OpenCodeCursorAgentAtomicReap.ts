import path from 'node:path'
import { unlink } from 'node:fs/promises'
import type { AttributionRecords } from './OpenCodeProcessAttributionStore.js'
import { killCursorAgentTree, nativePorts, positive, type CursorAgentNativePorts } from './OpenCodeCursorAgentTreeKill.js'

export type CursorAgentReapInput = {
  contractVersion: 1
  reason: 'team-stop' | 'startup'
  ownedWorkspaceCwds: readonly string[]
  startedBeforeMs: number
}
export type CursorAgentReapResult = {
  contractVersion: 1
  status: 'completed' | 'kept' | 'incomplete'
  killedPids: number[]
  diagnostics: string[]
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const absolute = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value)
const normalize = (value: string) => process.platform === 'win32'
  ? path.normalize(value).toLowerCase() : path.normalize(value)

export function parseCursorAgentReapInput(value: unknown, now = Date.now()): CursorAgentReapInput {
  if (!object(value) || Object.keys(value).length !== 4
    || !Object.keys(value).every(key => ['contractVersion', 'reason', 'ownedWorkspaceCwds', 'startedBeforeMs'].includes(key))
    || value.contractVersion !== 1 || !['team-stop', 'startup'].includes(String(value.reason))
    || !Array.isArray(value.ownedWorkspaceCwds) || value.ownedWorkspaceCwds.length < 1
    || value.ownedWorkspaceCwds.length > 128 || !value.ownedWorkspaceCwds.every(absolute)
    || !positive(value.startedBeforeMs) || value.startedBeforeMs > now) {
    throw new Error('Invalid cursor-agent reap contract')
  }
  return { contractVersion: 1, reason: value.reason as CursorAgentReapInput['reason'],
    ownedWorkspaceCwds: [...value.ownedWorkspaceCwds], startedBeforeMs: value.startedBeforeMs }
}

export async function reapCursorAgents(input: CursorAgentReapInput, raw: unknown,
  records: AttributionRecords, options: {
    deadline: number; guard: () => void; profileScope: string | undefined
    pendingOAuth: (key: string) => Promise<boolean>
    processLifetime: (key: string) => boolean
    native?: Partial<CursorAgentNativePorts>
  }, result: CursorAgentReapResult): Promise<void> {
  const keep = (reason: string) => { result.diagnostics.push(reason) }
  const check = () => { options.guard(); if (Date.now() >= options.deadline) throw new Error('Reap deadline exhausted') }
  if (!options.profileScope?.trim()) { keep('Runtime profile scope unavailable'); return }
  if (!object(raw) || raw.schemaVersion !== 1 || raw.processIdentityFormat !== 'platform-native-v2'
    || !object(raw.hosts)) { keep('Unsupported or malformed raw registry'); return }
  if (records.corruptPaths.length) { keep('Corrupt attribution evidence'); return }
  const ports = nativePorts(options.native)
  const scopes = new Set(input.ownedWorkspaceCwds.map(normalize))
  const hosts = Object.entries(raw.hosts)
  const protectedPids = new Set<number>([ports.selfPid])
  for (const [, host] of hosts) if (object(host) && positive(host.pid)) protectedPids.add(host.pid)
  for (const { record } of records.agents) if (record.kind === 'readiness-probe') protectedPids.add(record.pid)
  for (const { record } of records.hosts) protectedPids.add(record.hostPid)
  const count = <T>(items: T[], predicate: (item: T) => boolean) => items.filter(predicate).length
  let completed = false
  let kept = false
  for (const { record: agent } of records.agents) {
    check()
    const reject = (reason: string) => { kept = true; keep(`Kept pid=${agent.pid}: ${reason}`) }
    const workspace = agent.workspacePath ?? agent.cwd
    if (agent.kind !== 'cursor-agent'
      || !positive(agent.startedAtMs) || agent.startedAtMs >= input.startedBeforeMs
      || !absolute(workspace) || !scopes.has(normalize(workspace))
      || agent.appProfileScope !== options.profileScope) { reject('agent scope, kind or cutoff mismatch'); continue }
    if (count(records.agents, item => item.record.pid === agent.pid) !== 1) { reject('duplicate agent PID'); continue }
    const matches = hosts.filter(([, host]) => object(host) && host.attributionId === agent.attributionId)
    if (matches.length !== 1) { reject('absent or conflicting registered host'); continue }
    const [key, host] = matches[0]!
    if (!object(host) || host.hostKey !== key || !/^[0-9a-f]{32}$/.test(String(host.attributionId))
      || host.cursorAgentReapContractVersion !== 1 || !Number.isSafeInteger(host.pid) || !positive(host.pid)
      || !positive(host.processStartedAtMs) || !absolute(host.projectPath)
      || !scopes.has(normalize(host.projectPath)) || normalize(host.projectPath) !== normalize(workspace)
      || !object(host.leases) || Object.keys(host.leases).length !== 0
      || options.processLifetime(key)
      || count(hosts, ([, value]) => object(value) && value.pid === host.pid) !== 1) {
      reject('unsupported generation, nonempty/invalid leases or host identity'); continue
    }
    const attributed = records.hosts.filter(item => item.record.attributionId === agent.attributionId)
    if (attributed.length !== 1) { reject('absent or duplicate host attribution'); continue }
    const metadata = attributed[0]!.record
    const format = ports.platform === 'linux' ? 'linux-ticks'
      : ports.platform === 'darwin' || ports.platform === 'win32' ? 'epoch-ms' : 'unknown'
    if (format === 'unknown' || metadata.hostStartTimeFormat !== format
      || metadata.hostPid !== host.pid || metadata.hostStartedAtNative !== host.processStartedAtMs
      || !absolute(metadata.projectPath) || normalize(metadata.projectPath) !== normalize(host.projectPath)
      || metadata.appProfileScope !== options.profileScope
      || metadata.owners.length !== 0
      || (agent.appInstanceId && metadata.appInstanceId && agent.appInstanceId !== metadata.appInstanceId)) {
      reject('host attribution native identity or profile mismatch'); continue
    }
    check()
    try {
      if (await options.pendingOAuth(key)) { reject('pending OAuth owner'); continue }
    } catch { reject('pending OAuth authority unreadable'); continue }
    check()
    const timeout = () => { check(); return Math.max(1, Math.min(2000, options.deadline - Date.now())) }
    const hostBirth = await ports.birth(host.pid, timeout())
    check()
    if (!positive(hostBirth) || hostBirth !== host.processStartedAtMs) { reject('host native identity unavailable or changed'); continue }
    const live = await ports.birth(agent.pid, timeout())
    check()
    const matchesBirth = positive(live) && Number.isSafeInteger(live)
      && agent.nativeStartToken === `${format === 'linux-ticks' ? 'proc' : 'epoch'}:${live}`
    if (!matchesBirth || !positive(live)) { reject('agent native identity unavailable or changed'); continue }
    check()
    // A host Job contains the desktop host and potentially siblings. It is
    // never authority to terminate a Cursor agent. Windows must carry a
    // distinct agent Job/subtree identity written by the agent launch path.
    const expectedOsIdentity = typeof agent.processOsIdentity === 'string' ? agent.processOsIdentity : undefined
    if (ports.platform === 'darwin' && !expectedOsIdentity?.startsWith('darwin-audit:')) {
      reject('macOS launch-captured audit identity is unavailable'); continue
    }
    if (ports.platform === 'win32' && !expectedOsIdentity?.startsWith('win32-agent-job:')) {
      reject('Windows per-agent Job identity is unavailable'); continue
    }
    const killed = await killCursorAgentTree({ pid: agent.pid, expectedBirth: live,
      deadline: options.deadline, guard: check, protectedPids, expectedOsIdentity }, ports)
    result.killedPids.push(...killed.killedPids)
    result.diagnostics.push(...killed.diagnostics)
    if (!killed.complete) { result.status = 'incomplete'; return }
    // `complete` is the exact whole-tree receipt. This is the only cleanup
    // path allowed for a retained root-exit record.
    await unlink(agent.filePath).catch(() => undefined)
    completed = true
  }
  result.killedPids = [...new Set(result.killedPids)]
  result.status = kept || !completed ? 'kept' : 'completed'
  if (!records.agents.length) keep('No attributable candidate agents')
}
