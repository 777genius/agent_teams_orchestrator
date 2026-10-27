import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'

import { lock } from '../../utils/lockfile.js'
import { codexConversationOwnerKey, resolveCodexConversationOwner } from './conversationBinding.js'
import { writeCodexConversationOwnerReference } from './conversationOwnerReference.js'
import { unlinkExpiredCodexAwareTranscript } from './conversationRetention.js'

const roots: string[] = []
const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
const expired = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000)
const transcriptFs = { stat, unlink }

async function fixture(existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(path.join(tmpdir(), 'TEST-codex-retention-'))
  if (!existingRoot) roots.push(root)
  const sessionId = randomUUID()
  const transcript = path.join(root, `${sessionId}.jsonl`)
  await writeFile(transcript, JSON.stringify({ type: 'user', sessionId, uuid: randomUUID() }) + '\n')
  const owner = await resolveCodexConversationOwner({
    sessionId, transcriptPath: transcript, cwd: root, sourceProfile: root,
    agentId: 'TEST-agent', teamName: 'TEST-team',
  })
  const ownerKey = codexConversationOwnerKey(owner)
  const reference = { schemaVersion: 1 as const, ownerKey, sessionId }
  await writeCodexConversationOwnerReference(transcript, reference, { flush: async () => {} })
  const directory = path.join(path.dirname(owner.transcriptPath), 'codex-native', ownerKey)
  const sessions = path.join(directory, 'sessions')
  await mkdir(sessions, { recursive: true })
  const history = path.join(sessions, 'TEST-rollout.jsonl')
  await writeFile(history, 'TEST user and tool history')
  const bindingPath = path.join(directory, 'binding.json')
  const binding = {
    schemaVersion: 1, ownerKey, owner, state: 'ready', threadId: randomUUID(),
    startupContextHash: null, lastHostTurnId: null,
  }
  await writeFile(bindingPath, JSON.stringify(binding))
  await utimes(transcript, expired, expired)
  return { root, transcript, directory, sessions, history, bindingPath, binding, reference }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('expired transcript removes exactly its owned native history and leaves a neighbor intact', async () => {
  const first = await fixture()
  const neighbor = await fixture(first.root)
  expect(await unlinkExpiredCodexAwareTranscript(first.transcript, cutoff, transcriptFs)).toBe(true)
  expect(existsSync(first.transcript)).toBe(false)
  expect(existsSync(first.directory)).toBe(false)
  expect(await readFile(neighbor.history, 'utf8')).toBe('TEST user and tool history')
  expect(existsSync(neighbor.transcript)).toBe(true)
})

test('legacy transcripts retain the same age policy without touching unrelated native directories', async () => {
  const owned = await fixture()
  const legacy = path.join(owned.root, 'legacy.jsonl')
  await writeFile(legacy, '{"type":"user","message":"legacy"}\n')
  await utimes(legacy, expired, expired)
  expect(await unlinkExpiredCodexAwareTranscript(legacy, cutoff, transcriptFs)).toBe(true)
  expect(existsSync(legacy)).toBe(false)
  expect(existsSync(owned.history)).toBe(true)
})

test('a recent transcript survives normal retention and expires under the existing zero-day cutoff', async () => {
  const f = await fixture()
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  await utimes(f.transcript, yesterday, yesterday)
  expect(await unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, transcriptFs)).toBe(false)
  expect(existsSync(f.history)).toBe(true)
  expect(await unlinkExpiredCodexAwareTranscript(f.transcript, new Date(), transcriptFs)).toBe(true)
  expect(existsSync(f.directory)).toBe(false)
})

test('the actual conversation lock protects an old transcript and its rollout during an active turn', async () => {
  const f = await fixture()
  const release = await lock(f.binding.owner.transcriptPath, {
    lockfilePath: `${f.binding.owner.transcriptPath}.codex-native.lock`, realpath: false, retries: 0,
  })
  try {
    expect(await unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, transcriptFs)).toBe(false)
    expect(existsSync(f.transcript)).toBe(true)
    expect(existsSync(f.history)).toBe(true)
  } finally { await release() }
})

test.each(['creating', 'active'])('uncertain %s binding is retained even without a live lock', async state => {
  const f = await fixture()
  await writeFile(f.bindingPath, JSON.stringify({ ...f.binding, state }))
  expect(await unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, transcriptFs)).toBe(false)
  expect(existsSync(f.transcript)).toBe(true)
  expect(existsSync(f.history)).toBe(true)
})

test('rechecks age after acquiring the lock', async () => {
  const f = await fixture()
  expect(await unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, transcriptFs, {
    lock: async (file, options) => {
      const release = await lock(file, options)
      await utimes(f.transcript, new Date(), new Date())
      return release
    },
  })).toBe(false)
  expect(existsSync(f.history)).toBe(true)
})

test('rechecks age again after reading ownership and immediately before native removal', async () => {
  const f = await fixture()
  expect(await unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, {
    unlink,
    stat: async file => {
      await utimes(file, new Date(), new Date())
      return stat(file)
    },
  })).toBe(false)
  expect(existsSync(f.transcript)).toBe(true)
  expect(existsSync(f.history)).toBe(true)
})

test('lost lock ownership fences both deletion steps', async () => {
  const f = await fixture()
  let compromise: (() => void) | undefined
  await expect(unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, {
    unlink,
    stat: async file => { compromise?.(); return stat(file) },
  }, {
    lock: async (file, options) => {
      const release = await lock(file, options)
      compromise = () => options?.onCompromised?.(Object.assign(new Error('TEST lost lock'), { code: 'ECOMPROMISED' }))
      return release
    },
  })).rejects.toThrow('lost conversation ownership')
  expect(existsSync(f.transcript)).toBe(true)
  expect(existsSync(f.history)).toBe(true)
})

test.each(['owner-key-path', 'wrong-transcript', 'wrong-session', 'invalid-json', 'missing-binding'])(
  'refuses %s without deleting the transcript or any history', async kind => {
    const f = await fixture()
    if (kind === 'owner-key-path') {
      await writeFile(f.transcript, JSON.stringify({ type: 'codex-conversation-owner', ...f.reference, ownerKey: '../outside' }) + '\n')
      await utimes(f.transcript, expired, expired)
    } else if (kind === 'missing-binding') await unlink(f.bindingPath)
    else if (kind === 'invalid-json') await writeFile(f.bindingPath, '{')
    else await writeFile(f.bindingPath, JSON.stringify({ ...f.binding,
      owner: { ...f.binding.owner,
        ...(kind === 'wrong-transcript' ? { transcriptPath: path.join(f.root, 'another.jsonl') } : { sessionId: 'OTHER' }),
      },
    }))
    await expect(unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, transcriptFs)).rejects.toThrow()
    expect(existsSync(f.transcript)).toBe(true)
    expect(existsSync(f.history)).toBe(true)
  },
)

test.each(['root', 'owner', 'sessions'])('rejects a linked native %s rather than traversing its target', async kind => {
  const f = await fixture()
  const outside = path.join(f.root, 'outside')
  await mkdir(outside)
  const sentinel = path.join(outside, 'sentinel')
  await writeFile(sentinel, 'must survive')
  const target = kind === 'root' ? path.dirname(f.directory) : kind === 'owner' ? f.directory : f.sessions
  await rename(target, path.join(f.root, 'original-native'))
  await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, transcriptFs)).rejects.toThrow('linked')
  expect(await readFile(sentinel, 'utf8')).toBe('must survive')
  expect(existsSync(f.transcript)).toBe(true)
})

test('failed native removal keeps the owner reference for a later exact retry', async () => {
  const f = await fixture()
  await expect(unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, transcriptFs, {
    removeOwnedDirectory: async directory => {
      expect(directory).toBe(f.directory)
      throw new Error('TEST filesystem busy')
    },
  })).rejects.toThrow('TEST filesystem busy')
  expect(existsSync(f.transcript)).toBe(true)
  expect(existsSync(f.history)).toBe(true)
  expect(await unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, transcriptFs)).toBe(true)
})

test('failed transcript unlink after native removal remains retryable without orphan history', async () => {
  const f = await fixture()
  await expect(unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, {
    stat, unlink: async () => { throw new Error('TEST unlink blocked') },
  })).rejects.toThrow('TEST unlink blocked')
  expect(existsSync(f.transcript)).toBe(true)
  expect(existsSync(f.directory)).toBe(false)
  expect(await unlinkExpiredCodexAwareTranscript(f.transcript, cutoff, transcriptFs)).toBe(true)
})
