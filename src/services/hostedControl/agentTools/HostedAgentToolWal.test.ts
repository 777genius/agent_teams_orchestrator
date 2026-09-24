import { afterEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeHostedAgentToolRequest, hostedAgentToolResponse } from './HostedAgentToolContract.js'
import { HostedAgentToolWal, type HostedAgentToolBinding } from './HostedAgentToolWal.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const binding: HostedAgentToolBinding = {
  workspaceId: 'workspace_test', teamId: `team_${'a'.repeat(32)}`,
  workspaceRoot: '/sandbox/workspace', planGeneration: `plan-generation_${'b'.repeat(64)}`,
  runId: 'run_test', laneId: 'lane_primary', memberName: 'worker', sessionID: 'session_1',
}
const request = decodeHostedAgentToolRequest(JSON.stringify({
  version: 1, type: 'request', requestId: 'request_1', tool: 'hosted_task_start',
  context: { sessionID: 'session_1', messageID: 'message_1', callID: 'call_1' },
  args: { taskId: `task_${'c'.repeat(32)}` },
}))

describe('HostedAgentToolWal', () => {
  test('records one durable intent, treats restart ambiguity as operator required, then replays terminal', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-agent-tool-wal-')))
    roots.push(root)
    const path = join(root, 'agent-tools')
    const first = new HostedAgentToolWal(path)
    expect(await first.begin({ binding, request })).toEqual({ kind: 'admitted' })
    const restarted = new HostedAgentToolWal(path)
    expect(await restarted.begin({ binding, request })).toEqual({ kind: 'operator_required' })
    expect(await restarted.complete({ binding, request, result: 'started' })).toBe('completed')
    expect(await first.begin({ binding, request })).toEqual({ kind: 'replay', result: 'started' })
    expect(await first.complete({ binding, request, result: 'different' })).toBe('conflict')
  })

  test('same call ID with changed args, session, or Owner binding cannot become a second effect', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-agent-tool-wal-conflict-')))
    roots.push(root)
    const wal = new HostedAgentToolWal(join(root, 'agent-tools'))
    expect(await wal.begin({ binding, request })).toEqual({ kind: 'admitted' })
    const changedArgs = { ...request, args: { taskId: `task_${'d'.repeat(32)}` } }
    expect(await wal.begin({ binding, request: changedArgs })).toEqual({ kind: 'conflict' })
    expect(await wal.begin({ binding: { ...binding, runId: 'run_other' }, request })).toEqual({ kind: 'conflict' })
    await expect(wal.begin({ binding: { ...binding, sessionID: 'session_other' }, request })).rejects.toThrow()
  })

  test('private WAL records reject path substitution', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-agent-tool-wal-path-')))
    roots.push(root)
    const directory = join(root, 'agent-tools')
    const wal = new HostedAgentToolWal(directory)
    expect(await wal.begin({ binding, request })).toEqual({ kind: 'admitted' })
    const name = (await readdir(directory)).find(candidate => candidate.endsWith('.json'))!
    const file = join(directory, name)
    expect((await lstat(file)).mode & 0o777).toBe(0o600)
    await rm(file)
    await symlink('/tmp/hosted-agent-tool-not-a-record', file)
    await expect(wal.begin({ binding, request })).rejects.toThrow()
  })

  test('durably anchors the first directory and rejects replacement across Owner restart', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-agent-tool-wal-anchor-')))
    roots.push(root)
    const directory = join(root, 'agent-tools')
    const wal = new HostedAgentToolWal(directory)
    expect(await wal.begin({ binding, request })).toEqual({ kind: 'admitted' })
    const stat = await lstat(directory)
    const anchorPath = join(root, 'agent-tools.anchor.v1.json')
    expect((await lstat(anchorPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(anchorPath, 'utf8'))).toEqual({
      schemaVersion: 1, dev: String(stat.dev), ino: String(stat.ino),
    })
    await rename(directory, join(root, 'displaced-agent-tools'))
    await mkdir(directory, { mode: 0o700 })
    await expect(wal.begin({ binding, request })).rejects.toThrow('replaced')
    await expect(new HostedAgentToolWal(directory).begin({ binding, request })).rejects.toThrow('replaced')
  })

  test('a maximal quoted result remains terminal and replayable after JSON expansion', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-agent-tool-wal-result-')))
    roots.push(root)
    const wal = new HostedAgentToolWal(join(root, 'agent-tools'))
    const result = '"'.repeat(64 * 1024)
    expect(await wal.begin({ binding, request })).toEqual({ kind: 'admitted' })
    expect(await wal.complete({ binding, request, result })).toBe('completed')
    expect(await new HostedAgentToolWal(join(root, 'agent-tools')).begin({ binding, request }))
      .toEqual({ kind: 'replay', result })
  })

  test('a terminal result cannot be persisted if the response helper would reject it', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-agent-tool-wal-response-')))
    roots.push(root)
    const path = join(root, 'agent-tools')
    const wal = new HostedAgentToolWal(path)
    expect(await wal.begin({ binding, request })).toEqual({ kind: 'admitted' })
    expect(() => hostedAgentToolResponse(request.requestId, { result: 'done\0' })).toThrow()
    await expect(wal.complete({ binding, request, result: 'done\0' })).rejects.toThrow()
    expect(await new HostedAgentToolWal(path).begin({ binding, request }))
      .toEqual({ kind: 'operator_required' })
    expect(await wal.complete({ binding, request, result: 'done' })).toBe('completed')
    const replay = await new HostedAgentToolWal(path).begin({ binding, request })
    expect(replay).toEqual({ kind: 'replay', result: 'done' })
    if (replay.kind === 'replay') {
      expect(hostedAgentToolResponse(request.requestId, { result: replay.result })).toEqual({
        version: 1, type: 'response', requestId: request.requestId, ok: true, result: 'done',
      })
    }
  })

  test('a poisoned terminal record cannot replay an invalid response result', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-agent-tool-wal-poisoned-')))
    roots.push(root)
    const path = join(root, 'agent-tools')
    const wal = new HostedAgentToolWal(path)
    expect(await wal.begin({ binding, request })).toEqual({ kind: 'admitted' })
    expect(await wal.complete({ binding, request, result: 'done' })).toBe('completed')
    const file = join(path, (await readdir(path)).find(name => name.endsWith('.json'))!)
    const poisoned = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    poisoned.result = 'bad\0'
    await writeFile(file, `${JSON.stringify(poisoned)}\n`)
    await expect(new HostedAgentToolWal(path).begin({ binding, request })).rejects.toThrow()
  })

  test('concurrent first calls from distinct Owner WAL instances durably initialize once', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-agent-tool-wal-concurrent-')))
    roots.push(root)
    const path = join(root, 'agent-tools')
    const calls = Array.from({ length: 8 }, (_, index) => ({
      wal: new HostedAgentToolWal(path),
      request: { ...request, requestId: `request_${index}`,
        context: { ...request.context, callID: `call_${index}` } },
    }))
    expect(await Promise.all(calls.map(call => call.wal.begin({ binding, request: call.request }))))
      .toEqual(calls.map(() => ({ kind: 'admitted' })))
    expect(await Promise.all(calls.map(call => new HostedAgentToolWal(path)
      .begin({ binding, request: call.request }))))
      .toEqual(calls.map(() => ({ kind: 'operator_required' })))
  })
})
