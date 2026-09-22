import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import {
  resolveDirectWindowsLauncher,
  spawnPortableCli,
  spawnSyncPortableCli,
} from './portableCli.js'

const liveTest =
  process.env.AGENT_CLI_LAUNCH_LIVE_E2E === '1'
    ? test
    : test.skip
const CLI_LAUNCH_TIMEOUT_MS = 15_000

type AgentCliProvider = 'opencode' | 'codex' | 'claude'

type AgentCliSpec = {
  providerId: AgentCliProvider
  command: string
  overrideEnv: string
  versionPattern: RegExp
  expectsNodeShimOnWindows?: boolean
}

const AGENT_CLI_SPECS: AgentCliSpec[] = [
  {
    providerId: 'opencode',
    command: 'opencode',
    overrideEnv: 'OPENCODE_CLI_PATH',
    versionPattern: /\b\d+\.\d+\.\d+\b/,
    expectsNodeShimOnWindows: true,
  },
  {
    providerId: 'codex',
    command: 'codex',
    overrideEnv: 'CODEX_CLI_PATH',
    versionPattern: /\b(?:codex-cli\s+)?\d+\.\d+\.\d+\b/i,
    expectsNodeShimOnWindows: true,
  },
  {
    providerId: 'claude',
    command: 'claude',
    overrideEnv: 'CLAUDE_CLI_PATH',
    versionPattern: /\b\d+\.\d+\.\d+\b.*Claude Code/i,
  },
]

describe('portableCli agent launch live e2e', () => {
  for (const spec of AGENT_CLI_SPECS) {
    liveTest(
      `launches ${spec.providerId} through spawnSyncPortableCli without tmux`,
      () => {
        const binaryPath = resolveCliBinary(spec)
        expect(binaryPath.length).toBeGreaterThan(0)
        if (process.platform === 'win32' && spec.expectsNodeShimOnWindows) {
          expect(path.extname(binaryPath).toLowerCase()).toBe('.cmd')
          expect(resolveDirectWindowsLauncher(binaryPath)).not.toBeNull()
        }

        const result = spawnSyncPortableCli(binaryPath, ['--version'], {
          encoding: 'utf8',
          timeout: CLI_LAUNCH_TIMEOUT_MS,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()

        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(output).toMatch(spec.versionPattern)
        expect(output).not.toMatch(/tmux/i)
        expect(output).not.toMatch(/running scripts is disabled/i)
        expect(output).not.toMatch(/not digitally signed/i)
      },
      CLI_LAUNCH_TIMEOUT_MS + 5_000,
    )

    liveTest(
      `launches ${spec.providerId} through spawnPortableCli without tmux`,
      async () => {
        const binaryPath = resolveCliBinary(spec)
        expect(binaryPath.length).toBeGreaterThan(0)

        const result = await spawnAndCollect(binaryPath, ['--version'])
        const output = `${result.stdout}\n${result.stderr}`.trim()

        expect(result.exitCode).toBe(0)
        expect(output).toMatch(spec.versionPattern)
        expect(output).not.toMatch(/tmux/i)
        expect(output).not.toMatch(/running scripts is disabled/i)
        expect(output).not.toMatch(/not digitally signed/i)
      },
      CLI_LAUNCH_TIMEOUT_MS + 5_000,
    )
  }
})

function resolveCliBinary(spec: AgentCliSpec): string {
  const override = process.env[spec.overrideEnv]?.trim()
  if (override) {
    return preferWindowsCmdShim(override)
  }

  const whichResult = Bun.which(spec.command)
  if (whichResult) {
    return preferWindowsCmdShim(whichResult)
  }

  return preferWindowsCmdShim(resolveCommandFromPath(spec.command))
}

function resolveCommandFromPath(command: string): string {
  if (process.platform === 'win32') {
    const stdout = execFileSync('where.exe', [command], {
      encoding: 'utf8',
      timeout: CLI_LAUNCH_TIMEOUT_MS,
      windowsHide: true,
    })
    const candidates = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
    const cmdCandidate = candidates.find(candidate => /\.cmd$/i.test(candidate))
    return cmdCandidate ?? candidates[0] ?? command
  }

  return execFileSync('which', [command], {
    encoding: 'utf8',
    timeout: CLI_LAUNCH_TIMEOUT_MS,
  }).trim()
}

function preferWindowsCmdShim(binaryPath: string): string {
  if (process.platform !== 'win32') {
    return binaryPath
  }

  const extension = path.extname(binaryPath).toLowerCase()
  if (extension === '.cmd') {
    return binaryPath
  }

  const cmdPeer = extension
    ? `${binaryPath.slice(0, -extension.length)}.cmd`
    : `${binaryPath}.cmd`
  return existsSync(cmdPeer) ? cmdPeer : binaryPath
}

function spawnAndCollect(
  binaryPath: string,
  args: string[],
): Promise<{ exitCode: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnPortableCli(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`Timed out launching ${binaryPath}`))
      }
    }, CLI_LAUNCH_TIMEOUT_MS)

    child.stdout?.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', chunk => stderrChunks.push(Buffer.from(chunk)))
    child.once('error', error => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
    })
    child.once('close', exitCode => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        resolve({
          exitCode,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        })
      }
    })
  })
}
