import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import {
  acquireCodexNativeConversation,
  codexConversationOwnerKey,
  resolveCodexConversationOwner,
  type CodexConversationOwner,
  type CodexNativeConversation,
} from './conversationBinding.js'
import {
  readCodexConversationOwnerReference,
  writeCodexConversationOwnerReference,
} from './conversationOwnerReference.js'

type Dependencies = NonNullable<Parameters<typeof acquireCodexNativeConversation>[1]>
type LockOptions = Parameters<NonNullable<Dependencies['lock']>>[1]
const roots: string[] = []
const threadId = '12345678-1234-4234-8234-123456789abc'
const otherThreadId = '22345678-1234-4234-8234-123456789abc'
const contextHash = createHash('sha256').update('TEST trusted context').digest('hex')
const terminal = { submissionMayHaveStarted: true, turnTerminal: true, childStopped: true }
const notSubmitted = { submissionMayHaveStarted: false, turnTerminal: false, childStopped: true }
const userRow = (owner: CodexConversationOwner, uuid: string) =>
  JSON.stringify({ type: 'user', uuid, sessionId: owner.sessionId, message: { content: 'TEST input' } }) + '\n'

// Exercise the binding's lock contract without depending on the native lock
// package. Files, atomic writes and transcript ownership are real on-disk state.
function lockPort() {
  const held = new Map<string, LockOptions>()
  let releases = 0
  const lock: NonNullable<Dependencies['lock']> = async (file, options) => {
    if (held.has(file)) throw new Error('TEST lock already held')
    held.set(file, options)
    return async () => { held.delete(file); releases++ }
  }
  return {
    lock,
    held,
    releases: () => releases,
    compromise: () => {
      const options = held.values().next().value
      if (!options?.onCompromised) throw new Error('TEST no live lock')
      options.onCompromised(Object.assign(new Error('TEST ownership stolen'), { code: 'ECOMPROMISED' }))
    },
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-codex-binding-'))
  roots.push(root)
  const owner: CodexConversationOwner = {
    sessionId: randomUUID(),
    transcriptPath: path.join(root, 'transcripts', 'host.jsonl'),
    cwd: path.join(root, 'project'),
    agentId: 'nova@TEST-team',
    teamName: 'TEST-team',
    sourceProfile: path.join(root, 'source-profile'),
  }
  await Promise.all([
    mkdir(path.dirname(owner.transcriptPath), { recursive: true }),
    mkdir(owner.cwd),
    mkdir(owner.sourceProfile),
  ])
  const hostTurnId = randomUUID()
  await writeFile(owner.transcriptPath, userRow(owner, hostTurnId))
  const locks = lockPort()
  let flushes = 0
  const params = { owner, flush: async () => { flushes++ } }
  const acquire = (extra: Dependencies = {}) => acquireCodexNativeConversation(params, { lock: locks.lock, ...extra })
  return { root, owner, hostTurnId, locks, params, acquire, flushes: () => flushes }
}

function bindingPath(conversation: CodexNativeConversation): string {
  return path.join(path.dirname(conversation.sessionsDirectory), 'binding.json')
}

async function binding(conversation: CodexNativeConversation) {
  return JSON.parse(await readFile(bindingPath(conversation), 'utf8'))
}

async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  const conversation = await f.acquire()
  await conversation.recordThread(threadId)
  await conversation.settle({ ...terminal, contextAdmitted: true, startupContextHash: contextHash, hostTurnId: f.hostTurnId })
  await conversation.release()
  return conversation
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Codex native conversation binding', () => {
  test('persists host ownership before admission and resumes the exact native history after release', async () => {
    const f = await fixture()
    const first = await f.acquire()
    expect(first.isNew).toBe(true)
    expect(first.resumeThreadId).toBeUndefined()
    expect(f.flushes()).toBe(1)
    expect(await readCodexConversationOwnerReference(f.owner.transcriptPath)).toEqual({
      schemaVersion: 1,
      sessionId: f.owner.sessionId,
      ownerKey: codexConversationOwnerKey(await resolveCodexConversationOwner(f.owner)),
    })
    await first.recordThread(threadId)
    const nativeHistory = path.join(first.sessionsDirectory, 'TEST-rollout.jsonl')
    await writeFile(nativeHistory, 'TEST native user/tool/assistant history\n')
    await first.settle({ ...terminal, contextAdmitted: true, startupContextHash: contextHash, hostTurnId: f.hostTurnId })
    await first.release()

    const nextTurnId = randomUUID()
    await appendFile(f.owner.transcriptPath, userRow(f.owner, nextTurnId))
    const second = await f.acquire()
    expect(second.isNew).toBe(false)
    expect(second.resumeThreadId).toBe(threadId)
    expect(second.startupContextHash).toBe(contextHash)
    expect(second.sessionsDirectory).toBe(first.sessionsDirectory)
    expect(await readFile(nativeHistory, 'utf8')).toBe('TEST native user/tool/assistant history\n')
    await second.recordThread(threadId)
    await second.settle({ ...terminal, contextAdmitted: true, startupContextHash: contextHash, hostTurnId: nextTurnId })
    expect((await binding(second)).lastHostTurnId).toBe(nextTurnId)
    await second.release()
    expect(await readFile(nativeHistory, 'utf8')).toBe('TEST native user/tool/assistant history\n')
  })

  test('refuses concurrent admission and fences a released owner', async () => {
    const f = await fixture()
    const first = await f.acquire()
    const before = await readFile(bindingPath(first), 'utf8')
    await expect(f.acquire()).rejects.toThrow('another process owns')
    expect(await readFile(bindingPath(first), 'utf8')).toBe(before)
    await first.settle(notSubmitted)
    await first.release()
    await first.release()
    expect(f.locks.releases()).toBe(1)
    await expect(first.recordThread(threadId)).rejects.toThrow('already released')
    const next = await f.acquire()
    await next.settle(notSubmitted)
    await next.release()
  })

  test('serializes first ownership of one host transcript across different source profiles', async () => {
    const f = await fixture()
    let releaseFlush!: () => void
    let flushStarted!: () => void
    const barrier = new Promise<void>(resolve => { releaseFlush = resolve })
    const started = new Promise<void>(resolve => { flushStarted = resolve })
    const firstPending = acquireCodexNativeConversation({
      ...f.params,
      flush: async () => { flushStarted(); await barrier },
    }, { lock: f.locks.lock })
    await started
    let competing: CodexNativeConversation | undefined
    try {
      await expect((async () => {
        competing = await acquireCodexNativeConversation({
          ...f.params,
          owner: { ...f.owner, sourceProfile: path.join(f.root, 'OTHER-profile') },
        }, { lock: f.locks.lock })
      })()).rejects.toThrow('another process owns')
    } finally {
      releaseFlush()
      const first = await firstPending.catch(() => undefined)
      for (const conversation of [first, competing]) {
        if (!conversation) continue
        await conversation.settle(notSubmitted)
        await conversation.release()
      }
    }
  })

  test.each(['agentId', 'teamName', 'cwd', 'sourceProfile', 'sessionId'] as const)(
    'refuses a different %s for an existing host transcript', async field => {
      const f = await fixture()
      const previous = await ready(f)
      const before = await readFile(bindingPath(previous), 'utf8')
      const changed = { ...f.owner, [field]: `${f.owner[field]}-OTHER` }
      await expect(acquireCodexNativeConversation({ ...f.params, owner: changed }, { lock: f.locks.lock }))
        .rejects.toThrow('different agent, project, or Codex profile')
      expect(await readFile(bindingPath(previous), 'utf8')).toBe(before)
      expect(f.locks.held.size).toBe(0)
    },
  )

  test('an explicitly new host transcript gets isolated storage', async () => {
    const f = await fixture()
    const previous = await ready(f)
    const newOwner = { ...f.owner, sessionId: randomUUID(), transcriptPath: path.join(f.root, 'transcripts', 'new.jsonl') }
    await writeFile(newOwner.transcriptPath, userRow(newOwner, randomUUID()))
    const next = await acquireCodexNativeConversation({ ...f.params, owner: newOwner }, { lock: f.locks.lock })
    expect(next.isNew).toBe(true)
    expect(next.resumeThreadId).toBeUndefined()
    expect(next.sessionsDirectory).not.toBe(previous.sessionsDirectory)
    await next.settle(notSubmitted)
    await next.release()
  })

  test.each(['missing', 'invalid-json', 'wrong-owner', 'invalid-thread'])(
    'does not start fresh when the saved binding is %s', async scenario => {
      const f = await fixture()
      const previous = await ready(f)
      const saved = await binding(previous)
      if (scenario === 'missing') await rm(bindingPath(previous))
      else await writeFile(bindingPath(previous), scenario === 'invalid-json' ? '{' : JSON.stringify({
        ...saved,
        ...(scenario === 'wrong-owner' ? { ownerKey: 'another-owner' } : { threadId: 'not-a-thread-uuid' }),
      }))
      await expect(f.acquire()).rejects.toThrow('Codex conversation cannot be continued')
      expect(f.locks.held.size).toBe(0)
    },
  )

  test('loss of only the saved thread UUID cannot turn admitted history into a fresh conversation', async () => {
    const f = await fixture()
    const previous = await ready(f)
    const saved = await binding(previous)
    expect(saved).toMatchObject({
      state: 'ready',
      threadId,
      startupContextHash: contextHash,
      lastHostTurnId: f.hostTurnId,
    })
    const damaged = JSON.stringify({ ...saved, threadId: null })
    await writeFile(bindingPath(previous), damaged)

    await expect(f.acquire()).rejects.toThrow('Codex conversation cannot be continued')
    expect(await readFile(bindingPath(previous), 'utf8')).toBe(damaged)
    expect(f.locks.held.size).toBe(0)
  })

  test.each([false, true])('uncertain native outcome keeps the reservation (thread observed: %s)', async threadObserved => {
    const f = await fixture()
    const previous = await f.acquire()
    if (threadObserved) await previous.recordThread(threadId)
    await previous.settle({ submissionMayHaveStarted: true, turnTerminal: false, childStopped: true })
    await previous.release()
    await expect(f.acquire()).rejects.toThrow('unconfirmed outcome')
    expect((await binding(previous)).state).toBe(threadObserved ? 'active' : 'creating')
  })

  test('a terminal event without observed native identity never permits a fresh fallback', async () => {
    const f = await fixture()
    const previous = await f.acquire()
    await previous.settle({ ...terminal, contextAdmitted: true, startupContextHash: contextHash, hostTurnId: f.hostTurnId })
    await previous.release()
    await expect(f.acquire()).rejects.toThrow('unconfirmed outcome')
  })

  test('terminal output does not release uncertainty until native shutdown is confirmed', async () => {
    const f = await fixture()
    const previous = await f.acquire()
    await previous.recordThread(threadId)
    await previous.settle({ ...terminal, childStopped: false, contextAdmitted: true })
    await previous.release()
    await expect(f.acquire()).rejects.toThrow('unconfirmed outcome')
  })

  test.each([false, true])('proved pre-submission failure allows the next new request (existing history: %s)', async established => {
    const f = await fixture()
    if (established) await ready(f)
    const failed = await f.acquire()
    await failed.settle(notSubmitted)
    await failed.release()
    if (!established) {
      expect(await binding(failed)).toMatchObject({
        state: 'ready', threadId: null, startupContextHash: null, lastHostTurnId: null,
      })
    }
    const next = await f.acquire()
    expect(next.resumeThreadId).toBe(established ? threadId : undefined)
    expect(next.startupContextHash).toBe(established ? contextHash : null)
    await next.settle(notSubmitted)
    await next.release()
  })

  test('confirmed terminal interruption/error preserves history for a new request', async () => {
    const f = await fixture()
    const failed = await f.acquire()
    await failed.recordThread(threadId)
    await failed.settle({ ...terminal, contextAdmitted: true, startupContextHash: contextHash, hostTurnId: f.hostTurnId })
    await failed.release()
    const next = await f.acquire()
    expect(next.resumeThreadId).toBe(threadId)
    expect(next.startupContextHash).toBe(contextHash)
    await next.settle(notSubmitted)
    await next.release()
  })

  test('a native response cannot replace the owned thread UUID', async () => {
    const f = await fixture()
    await ready(f)
    const resumed = await f.acquire()
    await expect(resumed.recordThread(otherThreadId)).rejects.toThrow('different or invalid thread UUID')
    await expect(resumed.recordThread('latest')).rejects.toThrow('different or invalid thread UUID')
    expect((await binding(resumed)).threadId).toBe(threadId)
    await resumed.settle(notSubmitted)
    await resumed.release()
  })

  test('a failed lock does not create a host reference or a binding', async () => {
    const f = await fixture()
    await expect(f.acquire({ lock: async () => { throw new Error('TEST unavailable lock') } })).rejects.toThrow('another process owns')
    expect(await readCodexConversationOwnerReference(f.owner.transcriptPath)).toBeNull()
    const after = await f.acquire()
    expect(after.isNew).toBe(true)
    await after.settle(notSubmitted)
    await after.release()
  })

  test('lost lock ownership aborts the runner and prevents a native identity commit', async () => {
    const f = await fixture()
    let writes = 0
    const owner = await f.acquire({
      writeBinding: async (file, value, options) => {
        if (++writes === 2) f.locks.compromise()
        await writeJsonFileAtomic(file, value, options)
      },
    })
    await expect(owner.recordThread(threadId)).rejects.toThrow('ownership was lost')
    expect(owner.signal.aborted).toBe(true)
    await expect(owner.settle(notSubmitted)).rejects.toThrow('ownership was lost')
    expect((await binding(owner)).threadId).toBeNull()
    await owner.release()
    await expect(f.acquire()).rejects.toThrow('unconfirmed outcome')
  })

  test('physical loss of the accepted host turn cannot silently resume native history', async () => {
    const f = await fixture()
    const previous = await ready(f)
    const rows = (await readFile(f.owner.transcriptPath, 'utf8')).split('\n')
    await writeFile(f.owner.transcriptPath, rows.filter(row => !row.includes(f.hostTurnId)).join('\n'))
    await expect(f.acquire()).rejects.toThrow('recorded host turn')
    expect((await binding(previous)).state).toBe('ready')
  })

  test.each([false, true])('a failed owner-reference write before native admission remains retryable (committed: %s)', async committed => {
    const f = await fixture()
    await expect(f.acquire({
      writeOwnerReference: async (...args) => {
        if (committed) await writeCodexConversationOwnerReference(...args)
        throw new Error('TEST owner reference write failed')
      },
    })).rejects.toThrow('TEST owner reference write failed')
    expect(f.locks.held.size).toBe(0)
    const next = await f.acquire()
    expect(next.resumeThreadId).toBeUndefined()
    await next.settle(notSubmitted)
    await next.release()
  })
})
