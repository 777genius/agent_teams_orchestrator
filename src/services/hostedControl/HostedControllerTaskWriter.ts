import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { decodeHostedTaskMutationTerminalResult } from './protocol.js'
import type {
  HostedControlAuthority,
  HostedControlStableAuthority,
  HostedTaskMutationRequest,
  HostedTaskMutationTerminalResult,
} from './protocol.js'
import type { HostedProductTaskMutationPort, HostedTaskMutationOutcome } from './HostedProductTaskMutationWire.js'
import {
  HOSTED_CONTROL_PERSONAL_HOST_ADMISSION_KIND,
  type HostedControlAdmissionKind,
} from './HostedControlBootstrap.js'
import { verifyHostedAppMcpDescriptor, type HostedAppMcpDescriptor } from '../opencode/OpenCodeMcpManager.js'

/** Flag of the Product-built agent-teams MCP bundle that runs one hosted task command. */
export const HOSTED_TASK_COMMAND_FLAG = '--hosted-task-command'
const ANSWER_DEADLINE_MS = 4_000
const HARD_KILL_MS = 60_000
const LOCK_TIMEOUT_MS = 3_000
const RETRY_AFTER_MS = 1_000
const MAX_STDOUT_BYTES = 64 * 1024
const MAX_STDERR_BYTES = 2 * 1024
const MAX_SELF_WRITE_EFFECTS = 512
const TEAM_LEAD_NAME = 'team-lead'

type TaskCommandChild = ChildProcessByStdio<Writable, Readable, Readable>

export type HostedControllerTaskWriterOptions = {
  /** Verified appMcp node binary and bundle entry; the same bytes the team's agents run. */
  command: string
  entry: string
  /** Canonical admitted Claude root; the only root the command may touch. */
  claudeRoot: string
  legacyKey: string
  authority: HostedControlStableAuthority
  /** False once this Owner no longer holds the team; the command is then never started. */
  isCurrent: () => boolean | Promise<boolean>
  home?: string
  answerDeadlineMs?: number
  hardKillMs?: number
  lockTimeoutMs?: number
  spawnCommand?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => TaskCommandChild
  reportDiagnostic?: (diagnostic: HostedTaskCommandDiagnostic) => void
}

/** Fixed codes and counts only: never task text, paths or command output. */
export type HostedTaskCommandDiagnostic = {
  stage: 'deadline' | 'exit' | 'output'
  exitCode?: number | null
  stderrBytes?: number
}

/**
 * The Owner's task writer: every board mutation runs through the agent-teams controller, the one
 * task writer desktop and the MCP agents use, under the controller's own `<team>/board-state`
 * lock. The command runs as a child process because the controller lock waits synchronously.
 *
 * One command runs at a time. A command that outlives the answer deadline keeps running: its
 * writes span several files and must not be cut off, so the caller only learns `unavailable`
 * and the next mutation is refused until that command exits.
 */
export class HostedControllerTaskWriter implements HostedProductTaskMutationPort {
  readonly #options: HostedControllerTaskWriterOptions
  #running: Promise<void> | null = null

  constructor(options: HostedControllerTaskWriterOptions) {
    this.#options = options
  }

  async mutateWithSelfWriteEffects(request: HostedTaskMutationRequest): Promise<HostedTaskMutationOutcome> {
    if (!sameAuthority(request.authority, this.#options.authority)) return unavailable(false)
    if (this.#running) return unavailable(true)
    if (!(await this.#options.isCurrent())) return { result: { kind: 'unsafe_active' }, selfWriteEffects: [] }
    if (this.#running) return unavailable(true)
    const child = this.#spawn()
    const exited = new Promise<number | null>(resolve => {
      child.once('error', () => resolve(null))
      child.once('close', code => resolve(code))
    })
    const running = exited.then(() => undefined)
    this.#running = running
    void running.finally(() => { if (this.#running === running) this.#running = null })
    const hardKill = setTimeout(() => { child.kill('SIGKILL') }, this.#options.hardKillMs ?? HARD_KILL_MS)
    hardKill.unref?.()
    void exited.finally(() => clearTimeout(hardKill))

    const stdout = collect(child.stdout, MAX_STDOUT_BYTES)
    const stderr = collect(child.stderr, MAX_STDERR_BYTES)
    child.stdin.on('error', () => undefined)
    child.stdin.end(`${JSON.stringify(this.#input(request))}\n`)

    let deadline: ReturnType<typeof setTimeout> | undefined
    const code = await Promise.race([
      exited,
      new Promise<'deadline'>(resolve => {
        deadline = setTimeout(() => resolve('deadline'), this.#options.answerDeadlineMs ?? ANSWER_DEADLINE_MS)
        deadline.unref?.()
      }),
    ])
    clearTimeout(deadline)
    if (code === 'deadline') {
      this.#report({ stage: 'deadline' })
      return unavailable(true)
    }
    if (code !== 0) {
      this.#report({ stage: 'exit', exitCode: code, stderrBytes: (await stderr).bytes })
      return unavailable(true)
    }
    const output = await stdout
    try {
      if (output.truncated) throw new Error('Hosted task command output exceeds its limit')
      return decodeCommandOutput(output.text)
    } catch {
      this.#report({ stage: 'output' })
      return unavailable(true)
    }
  }

  #spawn(): TaskCommandChild {
    const options = { cwd: this.#options.claudeRoot, env: this.#env() }
    const args = [this.#options.entry, HOSTED_TASK_COMMAND_FLAG]
    if (this.#options.spawnCommand) return this.#options.spawnCommand(this.#options.command, args, options)
    return spawn(this.#options.command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  }

  /** Only what the command needs: the Owner's credentials and settings never reach Product bytes. */
  #env(): NodeJS.ProcessEnv {
    return {
      PATH: '/usr/bin:/bin',
      HOME: this.#options.home ?? process.env.HOME ?? this.#options.claudeRoot,
      AGENT_TEAMS_MCP_CLAUDE_DIR: this.#options.claudeRoot,
    }
  }

  #input(request: HostedTaskMutationRequest): Record<string, unknown> {
    const { authority } = this.#options
    return {
      schemaVersion: 1,
      kind: 'hosted_task_command',
      teamName: this.#options.legacyKey,
      board: {
        deploymentId: authority.deploymentId,
        bootId: authority.bootId,
        workspaceId: authority.workspaceId,
        mountGeneration: authority.mountBinding.mountGeneration,
        teamId: authority.teamId,
      },
      // The controller falls back to the team config's lead session when none is given.
      lead: { name: TEAM_LEAD_NAME, sessionId: null },
      lockTimeoutMs: this.#options.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
      payloadFingerprint: request.payload.payloadFingerprint,
      command: request.payload.command,
    }
  }

  #report(diagnostic: HostedTaskCommandDiagnostic): void {
    try {
      if (this.#options.reportDiagnostic) this.#options.reportDiagnostic(diagnostic)
      else process.stderr.write(`${JSON.stringify({ event: 'hosted_task_command', ...diagnostic })}\n`)
    } catch { /* diagnostics never change the answer */ }
  }
}

/**
 * Personal-host admissions run their agents as trusted host processes sharing the controller, so
 * they get the controller writer; every other admission refuses task mutations. The verified MCP
 * artifact is checked once here; hostedctl installs it root-owned and read-only.
 */
export async function createHostedTaskWriter(input: {
  admissionKind: HostedControlAdmissionKind | undefined
  appMcp: HostedAppMcpDescriptor | undefined
  claudeRoot: string
  legacyKey: string
  authority: HostedControlStableAuthority
  isCurrent: () => boolean | Promise<boolean>
}): Promise<HostedProductTaskMutationPort> {
  if (input.admissionKind !== HOSTED_CONTROL_PERSONAL_HOST_ADMISSION_KIND || !input.appMcp ||
    !(await verifyHostedAppMcpDescriptor(input.appMcp))) return failClosedHostedTaskWriter
  return new HostedControllerTaskWriter({
    command: input.appMcp.command,
    entry: input.appMcp.entry,
    claudeRoot: input.claudeRoot,
    legacyKey: input.legacyKey,
    authority: input.authority,
    isCurrent: input.isCurrent,
  })
}

/** Refuses every task mutation; for admissions whose agents may not share the host controller. */
export const failClosedHostedTaskWriter: HostedProductTaskMutationPort = Object.freeze({
  mutateWithSelfWriteEffects: async () => ({ result: { kind: 'unavailable' } as HostedTaskMutationTerminalResult, selfWriteEffects: [] }),
})

export function decodeCommandOutput(text: string): HostedTaskMutationOutcome {
  const lines = text.split('\n').filter(line => line.length > 0)
  if (lines.length !== 1) throw new Error('Hosted task command must print one line')
  const value = JSON.parse(lines[0]!) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hosted task command output is not an object')
  const output = value as Record<string, unknown>
  const keys = Object.keys(output).sort()
  if (keys.join(',') !== 'result,schemaVersion,selfWriteEffects' || output.schemaVersion !== 1) {
    throw new Error('Hosted task command output keys')
  }
  const result = decodeHostedTaskMutationTerminalResult(output.result)
  if (!Array.isArray(output.selfWriteEffects) || output.selfWriteEffects.length > MAX_SELF_WRITE_EFFECTS) {
    throw new Error('Hosted task command self-write effects')
  }
  const selfWriteEffects = output.selfWriteEffects.map(effect => {
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) throw new Error('Hosted task command self-write effect')
    const entry = effect as Record<string, unknown>
    if (Object.keys(entry).sort().join(',') !== 'expectedChecksum,fileKey' ||
      typeof entry.fileKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/.test(entry.fileKey) ||
      typeof entry.expectedChecksum !== 'string' || !/^[0-9a-f]{64}$/.test(entry.expectedChecksum)) {
      throw new Error('Hosted task command self-write effect')
    }
    return { fileKey: entry.fileKey, expectedChecksum: entry.expectedChecksum }
  })
  if (new Set(selfWriteEffects.map(effect => effect.fileKey)).size !== selfWriteEffects.length ||
    (result.kind !== 'committed' && selfWriteEffects.length > 0)) {
    throw new Error('Hosted task command self-write effects')
  }
  return { result, selfWriteEffects }
}

function unavailable(retry: boolean): HostedTaskMutationOutcome {
  return { result: retry ? { kind: 'unavailable', retryAfterMs: RETRY_AFTER_MS } : { kind: 'unavailable' }, selfWriteEffects: [] }
}

function sameAuthority(a: HostedControlAuthority, b: HostedControlStableAuthority): boolean {
  const { actorId: _, ...stable } = a
  const { actorId: _ignored, ...stableExpected } = b as HostedControlAuthority
  return JSON.stringify(stable) === JSON.stringify(stableExpected)
}

function collect(stream: Readable, limit: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let bytes = 0
    let truncated = false
    const done = (failed: boolean) => resolve({ text: Buffer.concat(chunks).toString('utf8'), bytes, truncated: truncated || failed })
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (size >= limit) { truncated = true; return }
      const slice = chunk.subarray(0, limit - size)
      if (slice.length < chunk.length) truncated = true
      chunks.push(slice)
      size += slice.length
    })
    stream.once('error', () => done(true))
    stream.once('end', () => done(false))
  })
}
