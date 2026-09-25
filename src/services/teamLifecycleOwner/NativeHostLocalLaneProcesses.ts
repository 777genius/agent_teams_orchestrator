import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  captureProcessTreeIdentity,
  isProcessAlive,
  isProcessGroupEmpty,
  readProcessCommandLine,
  readProcessStartTimeMs,
  terminateExpectedProcessTreeStable,
} from '../../utils/processKill.js'
import { isProcessBackendCommandForTeammate } from '../../utils/swarm/processBackend.js'

const PROCESS_LIST_TIMEOUT_MS = 5_000
const PROCESS_LIST_MAX_BYTES = 32 * 1024 * 1024
const TEAM_CONFIG_MAX_BYTES = 10 * 1024 * 1024
const TERMINATE_TIMEOUT_MS = 10_000
const TERMINATE_ESCALATION_TIMEOUT_MS = 5_000
const TERMINATE_POLL_MS = 100
const SWEEP_MAX_PASSES = 6
const SWEEP_PASS_DELAY_MS = 200

export type NativeProcessInfo = Readonly<{ pid: number; command: string }>

/** OS effects used by the native lane. Production binds every call to a process incarnation. */
export interface NativeHostLocalProcessPort {
  listProcesses(): Promise<NativeProcessInfo[] | null>
  readCommand(pid: number): Promise<string | null>
  readStartedAt(pid: number): Promise<number | null>
  captureIdentity(pid: number): Promise<string | null>
  /** Cooperative whole-group termination; completion is proven separately by the caller. */
  terminateTree(pid: number, startedAt: number, identity: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>
  isAlive(pid: number): boolean
  isGroupEmpty(pgid: number): Promise<boolean | null>
}

export function createProductionNativeProcessPort(
  platform: NodeJS.Platform = process.platform,
): NativeHostLocalProcessPort {
  return {
    listProcesses: () => platform === 'linux' ? listLinuxProcesses() : listPsProcesses(),
    readCommand: pid => readProcessCommandLine(pid, platform),
    readStartedAt: pid => readProcessStartTimeMs(pid, platform),
    captureIdentity: pid => captureProcessTreeIdentity(pid, platform),
    terminateTree: async (pid, startedAt, identity, signal) => {
      await terminateExpectedProcessTreeStable(pid, signal, startedAt, identity, {
        timeoutMs: TERMINATE_TIMEOUT_MS,
        pollMs: TERMINATE_POLL_MS,
        escalationTimeoutMs: TERMINATE_ESCALATION_TIMEOUT_MS,
        nowMs: Date.now,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        platform,
      })
    },
    isAlive: isProcessAlive,
    isGroupEmpty: pgid => isProcessGroupEmpty(pgid, platform),
  }
}

type TeammateProcessClaim = Readonly<{ agentId: string; ownerToken: string }>

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Crash sweep for one hosted team. It does not trust the runtime record: every
 * lead ever started for this team carries a spec path below `leadSpecPrefix`,
 * and every process teammate carries its durable owner token from config.json.
 * Each candidate is re-verified against its argv and start time before its
 * group is signalled. Sweeping repeats until a pass finds nothing, because a
 * lead frozen mid-bootstrap may already have claimed and started a teammate;
 * survivors of a graceful pass are killed. It confirms only after a clean scan
 * and after every signalled group is empty.
 */
export async function sweepNativeTeamProcesses(input: {
  port: NativeHostLocalProcessPort
  teamRoot: string
  teamName: string
  leadSpecPrefix: string
}): Promise<boolean> {
  const leadFlag = `--team-bootstrap-spec ${input.leadSpecPrefix}`
  const signalled = new Set<number>()
  let bound = true
  for (let pass = 0; pass < SWEEP_MAX_PASSES; pass += 1) {
    if (pass > 0) await sleep(SWEEP_PASS_DELAY_MS)
    const claims = await readTeammateProcessClaims(input.teamRoot, input.teamName)
    const listed = await input.port.listProcesses()
    if (!claims || !listed) return false
    const matches = (command: string) => command.includes(leadFlag) || claims.some(claim =>
      command.includes(`--process-owner-token ${claim.ownerToken}`) &&
      isProcessBackendCommandForTeammate(command, claim.agentId, input.teamName, claim.ownerToken))
    const candidates = listed.filter(entry => entry.pid !== process.pid && matches(entry.command))
    if (candidates.length === 0) {
      for (const pgid of signalled) {
        if (await input.port.isGroupEmpty(pgid) !== true) return false
      }
      return bound
    }
    for (const candidate of candidates) {
      const startedAt = await input.port.readStartedAt(candidate.pid)
      if (startedAt === null) {
        if (input.port.isAlive(candidate.pid)) bound = false
        continue
      }
      const command = await input.port.readCommand(candidate.pid)
      // The PID may have been reused between the scan and the start-time read.
      if (!command || !matches(command) || await input.port.readStartedAt(candidate.pid) !== startedAt) continue
      const identity = await input.port.captureIdentity(candidate.pid)
      if (!identity) {
        bound = false
        continue
      }
      const signal = signalled.has(candidate.pid) ? 'SIGKILL' : 'SIGTERM'
      await input.port.terminateTree(candidate.pid, startedAt, identity, signal).catch(() => undefined)
      signalled.add(candidate.pid)
    }
  }
  return false
}

/** Null means config.json exists but cannot be trusted, so the sweep fails closed. */
async function readTeammateProcessClaims(
  teamRoot: string,
  teamName: string,
): Promise<TeammateProcessClaim[] | null> {
  let raw: string
  try {
    const handle = await open(join(teamRoot, 'config.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > TEAM_CONFIG_MAX_BYTES) return null
      raw = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  if (!record || record.name !== teamName || !Array.isArray(record.members)) return null
  const claims: TeammateProcessClaim[] = []
  for (const value of record.members) {
    const member = value && typeof value === 'object' ? value as Record<string, unknown> : null
    const ownerToken = typeof member?.processOwnerToken === 'string' ? member.processOwnerToken.trim() : ''
    const agentId = typeof member?.agentId === 'string' ? member.agentId : ''
    // Tokens are generated identifiers; anything else cannot be a safe argv fragment.
    if (ownerToken && agentId && /^[A-Za-z0-9._:-]{8,256}$/.test(ownerToken)) {
      claims.push({ agentId, ownerToken })
    }
  }
  return claims
}

async function listLinuxProcesses(): Promise<NativeProcessInfo[] | null> {
  try {
    const entries = await readdir('/proc', { withFileTypes: true })
    const processes: NativeProcessInfo[] = []
    await Promise.all(entries.map(async entry => {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return
      const cmdline = await readFile(`/proc/${entry.name}/cmdline`).catch(() => null)
      // Zombies and kernel threads expose an empty cmdline and own no argv.
      if (!cmdline || cmdline.length === 0) return
      const command = cmdline.toString('utf8').replace(/\0+$/, '').split('\0').join(' ')
      processes.push({ pid: Number(entry.name), command })
    }))
    return processes
  } catch {
    return null
  }
}

function listPsProcesses(): Promise<NativeProcessInfo[] | null> {
  return new Promise(resolve => {
    execFile('ps', ['-axo', 'pid=,command='], {
      timeout: PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: PROCESS_LIST_MAX_BYTES,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const processes: NativeProcessInfo[] = []
      for (const line of stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line)
        if (match) processes.push({ pid: Number(match[1]), command: match[2]! })
      }
      resolve(processes)
    })
  })
}
