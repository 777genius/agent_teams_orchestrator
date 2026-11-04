import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { getFlagSettingsInline, setFlagSettingsInline } from '../bootstrap/state.js'
import { acquireCodexNativeConversation } from '../services/codexNative/conversationBinding.js'
import { cleanupOldSessionFiles } from './cleanup.js'
import { getFsImplementation, NodeFsOperations, setFsImplementation } from './fsOperations.js'
import { check, lock } from './lockfile.js'
import { resetSettingsCache } from './settings/settingsCache.js'

const expired = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
let root: string
let projectDir: string
let previousConfigDir: string | undefined
let previousSettings: ReturnType<typeof getFlagSettingsInline>
let previousFs: ReturnType<typeof getFsImplementation>

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  previousSettings = getFlagSettingsInline()
  previousFs = getFsImplementation()
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-cleanup-codex-locks-')))
  process.env.CLAUDE_CONFIG_DIR = root
  setFlagSettingsInline({ cleanupPeriodDays: 30 })
  resetSettingsCache()
  setFsImplementation(NodeFsOperations)
  projectDir = path.join(root, 'projects', 'TEST-project')
  await mkdir(projectDir, { recursive: true })
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  setFlagSettingsInline(previousSettings)
  resetSettingsCache()
  setFsImplementation(previousFs)
  await rm(root, { recursive: true, force: true })
})

test('session cleanup preserves a real active Codex lock while removing ordinary expired session data', async () => {
  const sessionId = randomUUID()
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
  await writeFile(transcriptPath, JSON.stringify({ type: 'user', sessionId, uuid: randomUUID() }) + '\n')
  const params = {
    owner: {
      sessionId, transcriptPath, cwd: root, sourceProfile: root,
      agentId: 'TEST-agent', teamName: 'TEST-team',
    },
    flush: async () => {},
  }
  const active = await acquireCodexNativeConversation(params)
  try {
    await active.recordThread(randomUUID())
    const history = path.join(active.sessionsDirectory, 'TEST-rollout.jsonl')
    await writeFile(history, 'TEST active native history')
    await utimes(transcriptPath, expired, expired)
    const expiredNeighbor = path.join(projectDir, `${randomUUID()}.jsonl`)
    await writeFile(expiredNeighbor, '{"type":"user","message":"TEST expired legacy history"}\n')
    await utimes(expiredNeighbor, expired, expired)
    const emptySession = path.join(projectDir, randomUUID())
    await mkdir(emptySession)

    expect(await cleanupOldSessionFiles()).toEqual({ messages: 1, errors: 0 })
    const lockfilePath = `${transcriptPath}.codex-native.lock`
    expect(existsSync(lockfilePath)).toBe(true)
    expect(await check(transcriptPath, { lockfilePath, realpath: false })).toBe(true)
    await expect(acquireCodexNativeConversation(params)).rejects.toThrow('another process owns')
    expect(existsSync(transcriptPath)).toBe(true)
    expect(await readFile(history, 'utf8')).toBe('TEST active native history')
    expect(existsSync(expiredNeighbor)).toBe(false)
    expect(existsSync(emptySession)).toBe(false)
  } finally {
    await active.settle({ submissionMayHaveStarted: false, turnTerminal: false, childStopped: true })
    await active.release()
  }
})

test('session cleanup leaves stale Codex lock recovery to proper-lockfile and ordinary transcript retention', async () => {
  const transcript = path.join(projectDir, `${randomUUID()}.jsonl`)
  await writeFile(transcript, '{"type":"user","message":"TEST recent transcript"}\n')
  const lockfilePath = `${transcript}.codex-native.lock`
  await mkdir(lockfilePath)
  await utimes(lockfilePath, expired, expired)

  expect(await cleanupOldSessionFiles()).toEqual({ messages: 0, errors: 0 })
  expect(existsSync(lockfilePath)).toBe(true)
  expect((await stat(lockfilePath)).mtime.getTime()).toBeLessThan(Date.now() - 60_000)
  const release = await lock(transcript, { lockfilePath, realpath: false, retries: 0 })
  try {
    expect(await check(transcript, { lockfilePath, realpath: false })).toBe(true)
  } finally { await release() }
  expect(existsSync(lockfilePath)).toBe(false)

  // When the owning transcript itself expires, retention may acquire/reap the
  // stale lock normally; reserving its directory name must not disable cleanup.
  await utimes(transcript, expired, expired)
  await mkdir(lockfilePath)
  await utimes(lockfilePath, expired, expired)
  expect(await cleanupOldSessionFiles()).toEqual({ messages: 1, errors: 0 })
  expect(existsSync(transcript)).toBe(false)
  expect(existsSync(lockfilePath)).toBe(false)
})
