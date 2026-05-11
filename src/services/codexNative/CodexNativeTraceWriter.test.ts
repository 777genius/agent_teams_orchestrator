import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import { CodexNativeTraceWriter } from './CodexNativeTraceWriter.js'
import { getTeamTaskLogFreshnessSignalFilePath } from '../boardTaskActivity/TaskLogFreshnessSignal.js'

const TRACE_ENV = 'AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT'
const TRACE_WRITE_ENV = 'CLAUDE_CODE_CODEX_NATIVE_TRACE_WRITE_ENABLED'

let runtimeRoot: string
let projectDir: string
let previousClaudeConfigDir: string | undefined

function traceSegment(value: string): string {
  return encodeURIComponent(value)
}

async function readJsonl(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(filePath, 'utf8')
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('CodexNativeTraceWriter', () => {
  beforeEach(async () => {
    runtimeRoot = await mkdtemp(path.join(tmpdir(), 'codex-native-runtime-'))
    projectDir = await mkdtemp(path.join(tmpdir(), 'codex-native-project-'))
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = runtimeRoot
    process.env[TRACE_ENV] = runtimeRoot
    delete process.env[TRACE_WRITE_ENV]
  })

  afterEach(async () => {
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    }
    delete process.env[TRACE_ENV]
    delete process.env[TRACE_WRITE_ENV]
    await rm(runtimeRoot, { recursive: true, force: true })
    await rm(projectDir, { recursive: true, force: true })
  })

  test('writes bounded raw trace with stable projections and task-log freshness signal', async () => {
    const writer = new CodexNativeTraceWriter({ cwd: projectDir, codexVersion: '0.125.0' })
    await writer.recordStdoutLine(
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'mcp_1',
          type: 'mcp_tool_call',
          server: 'agent-teams',
          tool: 'task_start',
          arguments: {
            teamName: 'vector-room-131313',
            taskId: '8421e1bb-2f3b-4656-9983-6e0fd4b15963',
          },
          status: 'in_progress',
        },
      })
    )
    await writer.recordStdoutLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'pwd && ls',
          aggregated_output: '/repo\nfile.txt\n',
          exit_code: 0,
          status: 'completed',
        },
      })
    )
    await writer.finish({ outcome: 'success', exitCode: 0, signal: null })

    const processedDir = path.join(
      runtimeRoot,
      'codex-native-traces',
      'processed',
      traceSegment('vector-room-131313'),
      traceSegment('8421e1bb-2f3b-4656-9983-6e0fd4b15963')
    )
    const files = await readdir(processedDir)
    expect(files).toHaveLength(1)
    expect(files[0]?.endsWith('.jsonl')).toBe(true)

    const tracePath = path.join(processedDir, files[0]!)
    const fileMode = (await stat(tracePath)).mode & 0o777
    expect(fileMode).toBe(0o600)

    const records = await readJsonl(tracePath)
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      recordType: 'codex_native_trace_header',
      teamName: 'vector-room-131313',
      taskId: '8421e1bb-2f3b-4656-9983-6e0fd4b15963',
      provider: 'codex',
      cwd: projectDir,
      codexVersion: '0.125.0',
    })
    const commandRecord = records.find(record => {
      const projection = record.projection as Record<string, unknown> | undefined
      return projection?.itemId === 'item_1'
    })
    expect(commandRecord).toMatchObject({
      recordType: 'codex_native_stdout_event',
      projection: {
        kind: 'tool_result',
        toolSource: 'native',
        rawItemType: 'command_execution',
        itemId: 'item_1',
        toolName: 'Bash',
        input: { command: 'pwd && ls' },
        result: {
          content: '/repo\nfile.txt\n',
          stdout: '/repo\nfile.txt\n',
          exitCode: 0,
        },
        isError: false,
      },
    })
    expect(records.at(-1)).toMatchObject({
      recordType: 'codex_native_trace_footer',
      outcome: 'success',
      exitCode: 0,
      stdoutEventCount: 2,
    })

    const freshnessPath = getTeamTaskLogFreshnessSignalFilePath(
      'vector-room-131313',
      '8421e1bb-2f3b-4656-9983-6e0fd4b15963'
    )
    expect((await readFile(freshnessPath, 'utf8')).includes('codex-native-trace')).toBe(true)

    let legacyProjectFreshnessExists = true
    try {
      await stat(path.join(projectDir, '.board-task-log-freshness'))
    } catch {
      legacyProjectFreshnessExists = false
    }
    expect(legacyProjectFreshnessExists).toBe(false)
  })

  test('does not create trace files when the writer feature gate is disabled', async () => {
    process.env[TRACE_WRITE_ENV] = 'false'
    const writer = new CodexNativeTraceWriter({ cwd: projectDir, codexVersion: '0.125.0' })
    await writer.recordStdoutLine(
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'mcp_1',
          type: 'mcp_tool_call',
          server: 'agent-teams',
          tool: 'task_start',
          arguments: { teamName: 'vector-room-131313', taskId: 'task-a' },
          status: 'in_progress',
        },
      })
    )
    await writer.finish({ outcome: 'success' })

    let missingTraceRoot = false
    try {
      await readdir(path.join(runtimeRoot, 'codex-native-traces'))
    } catch {
      missingTraceRoot = true
    }
    expect(missingTraceRoot).toBe(true)
  })

  test('does not fall back to cwd freshness when task id has no team name', async () => {
    const writer = new CodexNativeTraceWriter({ cwd: projectDir, codexVersion: '0.125.0' })
    await writer.recordStdoutLine(
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'mcp_1',
          type: 'mcp_tool_call',
          server: 'agent-teams',
          tool: 'task_start',
          arguments: {
            taskId: 'task-without-team',
          },
          status: 'in_progress',
        },
      })
    )
    await writer.finish({ outcome: 'success', exitCode: 0, signal: null })

    let legacyProjectFreshnessExists = true
    try {
      await stat(path.join(projectDir, '.board-task-log-freshness'))
    } catch {
      legacyProjectFreshnessExists = false
    }
    expect(legacyProjectFreshnessExists).toBe(false)
  })
})
