import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

import {
  getCwdState,
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  setCwdState,
  setOriginalCwd,
  switchSession,
} from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import { createAssistantMessage } from '../../utils/messages.js'
import {
  flushSessionStorage,
  getTranscriptPath,
  recordTranscript,
  resetProjectForTesting,
} from '../../utils/sessionStorage.js'
import { getBoardTaskLogFreshnessSignalFilePath } from './TaskLogFreshnessSignal.js'
import type { TaskAwareMessage } from './contract.js'

describe('BoardTask transcript persistence', () => {
  let tempConfigDir: string
  let previousClaudeConfigDir: string | undefined
  let previousTestPersistence: string | undefined
  let previousOriginalCwd: string
  let previousCwd: string
  let previousSessionId: SessionId
  let previousSessionProjectDir: string | null

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), 'board-task-transcript-'))
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    previousTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

    previousOriginalCwd = getOriginalCwd()
    previousCwd = getCwdState()
    previousSessionId = getSessionId()
    previousSessionProjectDir = getSessionProjectDir()

    setOriginalCwd(tempConfigDir)
    setCwdState(tempConfigDir)
    switchSession(randomUUID() as SessionId, null)
    resetProjectForTesting()
  })

  afterEach(async () => {
    await flushSessionStorage()
    resetProjectForTesting()

    switchSession(previousSessionId, previousSessionProjectDir)
    setOriginalCwd(previousOriginalCwd)
    setCwdState(previousCwd)

    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    }
    if (previousTestPersistence === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousTestPersistence
    }

    rmSync(tempConfigDir, { recursive: true, force: true })
  })

  test('persists board-task carrier fields into transcript jsonl', async () => {
    const message = createAssistantMessage({
      content: 'Working through the task details.',
    }) as TaskAwareMessage

    message.boardTaskLinks = [
      {
        schemaVersion: 1,
        task: {
          ref: 'abcd1234',
          refKind: 'display',
          canonicalId: '123e4567-e89b-12d3-a456-426614174000',
        },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: {
          relation: 'same_task',
        },
      },
    ]

    await recordTranscript([message])
    await flushSessionStorage()

    const transcriptPath = getTranscriptPath()
    const lines = readFileSync(transcriptPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
    const assistantLine = lines
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(entry => entry.uuid === message.uuid)

    expect(assistantLine).toBeDefined()
    expect(assistantLine?.boardTaskLinks).toEqual([
      {
        schemaVersion: 1,
        task: {
          ref: 'abcd1234',
          refKind: 'display',
          canonicalId: '123e4567-e89b-12d3-a456-426614174000',
        },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: {
          relation: 'same_task',
        },
      },
    ])
  })

  test('touches per-task freshness signal after transcript persistence', async () => {
    const taskId = '123e4567-e89b-12d3-a456-426614174111'
    const message = createAssistantMessage({
      content: 'Adding another task-linked transcript message.',
    }) as TaskAwareMessage

    message.boardTaskLinks = [
      {
        schemaVersion: 1,
        task: {
          ref: taskId,
          refKind: 'canonical',
          canonicalId: taskId,
        },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: {
          relation: 'same_task',
        },
      },
    ]

    await recordTranscript([message])
    await flushSessionStorage()

    const transcriptPath = getTranscriptPath()
    const projectDir = join(transcriptPath, '..')
    const freshnessPath = getBoardTaskLogFreshnessSignalFilePath(projectDir, taskId)
    const freshnessEntry = JSON.parse(readFileSync(freshnessPath, 'utf8')) as {
      taskId?: string
      transcriptFile?: string
      updatedAt?: string
    }

    expect(freshnessEntry.taskId).toBe(taskId)
    expect(freshnessEntry.transcriptFile).toBe(`${getSessionId()}.jsonl`)
    expect(typeof freshnessEntry.updatedAt).toBe('string')
  })
})
