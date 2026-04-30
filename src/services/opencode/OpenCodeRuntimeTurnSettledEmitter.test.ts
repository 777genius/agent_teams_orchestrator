import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  FileOpenCodeRuntimeTurnSettledEmitter,
  RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV,
  emitOpenCodeRuntimeTurnSettledBestEffort,
} from './OpenCodeRuntimeTurnSettledEmitter.js'

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opencode-turn-settled-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('FileOpenCodeRuntimeTurnSettledEmitter', () => {
  test('writes OpenCode turn-settled events atomically into shared spool', async () => {
    const root = await makeTempRoot()
    const emitter = new FileOpenCodeRuntimeTurnSettledEmitter({
      [RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]: root,
    } as NodeJS.ProcessEnv)

    await emitter.emit({
      schemaVersion: 1,
      provider: 'opencode',
      eventName: 'runtime_turn_settled',
      hookEventName: 'Stop',
      source: 'agent-teams-orchestrator-opencode',
      recordedAt: '2026-04-29T12:00:00.000Z',
      sessionId: 'session-1',
      teamName: 'team-a',
      memberName: 'alice',
      laneId: 'primary',
      cwd: '/tmp/project',
      outcome: 'success',
      runtimePromptMessageId: 'msg_123',
      turnId: 'msg_123',
      selectedModel: 'openrouter/qwen/qwen3-coder',
      runtimePid: 123,
    })

    const files = await readdir(join(root, 'incoming'))
    expect(files).toHaveLength(1)
    expect(files[0]?.endsWith('.opencode.json')).toBe(true)
    expect(files[0]?.startsWith('.')).toBe(false)

    const payload = JSON.parse(await readFile(join(root, 'incoming', files[0] ?? ''), 'utf8'))
    expect(payload).toMatchObject({
      provider: 'opencode',
      source: 'agent-teams-orchestrator-opencode',
      sessionId: 'session-1',
      runtimePromptMessageId: 'msg_123',
      outcome: 'success',
    })
  })

  test('best-effort emitter never rejects delivery path', async () => {
    await expect(
      emitOpenCodeRuntimeTurnSettledBestEffort(
        {
          schemaVersion: 1,
          provider: 'opencode',
          eventName: 'runtime_turn_settled',
          hookEventName: 'Stop',
          source: 'agent-teams-orchestrator-opencode',
          recordedAt: '2026-04-29T12:00:00.000Z',
          sessionId: 'session-1',
          teamName: 'team-a',
          memberName: 'alice',
          laneId: 'primary',
          cwd: '/tmp/project',
          outcome: 'success',
        },
        {
          emit: async () => {
            throw new Error('disk full')
          },
        },
      ),
    ).resolves.toBeUndefined()
  })
})
