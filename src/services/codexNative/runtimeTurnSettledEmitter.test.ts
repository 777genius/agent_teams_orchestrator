import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  FileCodexNativeTurnSettledEmitter,
  RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV,
  type CodexNativeTurnSettledEvent,
} from './runtimeTurnSettledEmitter.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-turn-settled-'))
  tempDirs.push(directory)
  return directory
}

function makeEvent(): CodexNativeTurnSettledEvent {
  return {
    schemaVersion: 1,
    provider: 'codex',
    eventName: 'runtime_turn_settled',
    hookEventName: 'Stop',
    source: 'agent-teams-orchestrator-codex-native',
    recordedAt: '2026-04-29T12:00:00.000Z',
    sessionId: 'ses-1',
    agentId: 'jack@alpha',
    agentName: 'jack',
    teamName: 'alpha',
    cwd: '/tmp/project',
    outcome: 'success',
    threadId: 'thread-1',
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('FileCodexNativeTurnSettledEmitter', () => {
  test('writes Codex turn-settled payloads into the shared runtime hook spool', async () => {
    const spoolRoot = await makeTempDir()
    const emitter = new FileCodexNativeTurnSettledEmitter({
      [RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]: spoolRoot,
    })

    await emitter.emit(makeEvent())

    const incomingDir = join(spoolRoot, 'incoming')
    const files = await readdir(incomingDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toEndWith('.codex.json')
    const payload = JSON.parse(await readFile(join(incomingDir, files[0]), 'utf8'))
    expect(payload).toMatchObject({
      provider: 'codex',
      eventName: 'runtime_turn_settled',
      agentName: 'jack',
      teamName: 'alpha',
      outcome: 'success',
    })
  })

  test('is a no-op when no spool root is configured', async () => {
    const emitter = new FileCodexNativeTurnSettledEmitter({})
    await expect(emitter.emit(makeEvent())).resolves.toBeUndefined()
  })
})
