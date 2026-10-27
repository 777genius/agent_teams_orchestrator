import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'

import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { lock } from '../../utils/lockfile.js'
import {
  readCodexConversationOwnerReference,
  writeCodexConversationOwnerReference,
} from './conversationOwnerReference.js'
import type { CodexNativeRunnerLifecycle } from './runnerLifecycle.js'

export type CodexConversationOwner = {
  sessionId: string
  transcriptPath: string
  cwd: string
  agentId: string | null
  teamName: string | null
  sourceProfile: string
}

type Binding = {
  schemaVersion: 1
  ownerKey: string
  owner: CodexConversationOwner
  state: 'creating' | 'active' | 'ready'
  threadId: string | null
  startupContextHash: string | null
  lastHostTurnId: string | null
}

export type CodexNativeConversation = {
  sessionsDirectory: string
  resumeThreadId: string | undefined
  startupContextHash: string | null
  isNew: boolean
  signal: AbortSignal
  assertOwned: () => void
  verifyHostTurn: (hostTurnId: string) => Promise<void>
  recordThread: (threadId: string) => Promise<void>
  settle: (result: CodexNativeRunnerLifecycle & {
    contextAdmitted?: boolean
    startupContextHash?: string | null
    hostTurnId?: string | null
  }) => Promise<void>
  release: () => Promise<void>
}

type ConversationDeps = {
  lock?: typeof lock
  readOwnerReference?: typeof readCodexConversationOwnerReference
  writeOwnerReference?: typeof writeCodexConversationOwnerReference
  writeBinding?: typeof writeJsonFileAtomic
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function refusal(reason: string): Error {
  return new Error(
    `Codex conversation cannot be continued: ${reason}. No message was replayed. ` +
    'Restore the session storage or start an explicitly new conversation.',
  )
}

async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value)
  try {
    return await realpath(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A first transcript/profile may not exist yet. Resolve its existing
    // ancestors so creating it cannot change identity through a parent symlink
    // or a Windows short-path alias on the next turn.
    const parent = path.dirname(resolved)
    return parent === resolved ? resolved : path.join(await canonicalPath(parent), path.basename(resolved))
  }
}

export async function resolveCodexConversationOwner(
  owner: CodexConversationOwner,
): Promise<CodexConversationOwner> {
  return {
    ...owner,
    transcriptPath: await canonicalPath(owner.transcriptPath),
    cwd: await canonicalPath(owner.cwd),
    sourceProfile: await canonicalPath(owner.sourceProfile),
  }
}

export function codexConversationOwnerKey(owner: CodexConversationOwner): string {
  // Explicit field order also makes callers' object property order irrelevant.
  return createHash('sha256').update(JSON.stringify([
    owner.sessionId, owner.transcriptPath, owner.cwd, owner.agentId,
    owner.teamName, owner.sourceProfile,
  ])).digest('hex')
}

/** Stable address even before a resumed lead's agent/team identity is restored. */
export function codexConversationDirectory(canonicalTranscriptPath: string): string {
  const storageKey = createHash('sha256').update(canonicalTranscriptPath).digest('hex')
  return path.join(path.dirname(canonicalTranscriptPath), 'codex-native', storageKey)
}

function parseBinding(value: unknown, ownerKey: string): Binding {
  const b = value as Partial<Binding> | null
  if (!b || b.schemaVersion !== 1 || b.ownerKey !== ownerKey || !b.owner ||
      codexConversationOwnerKey(b.owner) !== ownerKey ||
      !['creating', 'active', 'ready'].includes(b.state ?? '') ||
      !(b.threadId === null || (typeof b.threadId === 'string' && UUID_PATTERN.test(b.threadId))) ||
      !(b.startupContextHash === null || (typeof b.startupContextHash === 'string' && /^[0-9a-f]{64}$/.test(b.startupContextHash))) ||
      !(b.lastHostTurnId === null || typeof b.lastHostTurnId === 'string') ||
      (b.threadId === null && (b.startupContextHash !== null || b.lastHostTurnId !== null)) ||
      (b.state === 'active' && !b.threadId)) {
    throw refusal('saved native binding is invalid or belongs to another owner')
  }
  return b as Binding
}

/**
 * A full host resume may need the saved lead identity before AppState exists.
 * Read it only through the physical transcript reference, and still require
 * the current host session, project and source profile to match exactly.
 * The caller must verify the existing team's lead membership before restoring
 * that identity. acquire() repeats ownership validation under its writer lock.
 */
export async function readCodexConversationOwnerForFullResume(
  current: Omit<CodexConversationOwner, 'agentId' | 'teamName'>,
): Promise<CodexConversationOwner | null> {
  const canonical = await resolveCodexConversationOwner({
    ...current, agentId: null, teamName: null,
  })
  const reference = await readCodexConversationOwnerReference(canonical.transcriptPath)
  const bindingPath = path.join(codexConversationDirectory(canonical.transcriptPath), 'binding.json')
  let serializedBinding: string
  try {
    serializedBinding = await readFile(bindingPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !reference) return null
    throw refusal('the saved native binding is missing or unreadable')
  }
  if (!reference) throw refusal('the host conversation owner reference is missing')
  if (reference.sessionId !== canonical.sessionId || !/^[0-9a-f]{64}$/.test(reference.ownerKey)) {
    throw refusal('the resumed host conversation has a different or invalid owner')
  }
  let binding: Binding
  try {
    binding = parseBinding(JSON.parse(serializedBinding), reference.ownerKey)
  } catch (error) {
    throw refusal(error instanceof Error ? error.message : 'cannot read the saved binding')
  }
  if (codexConversationOwnerKey({
    ...canonical, agentId: binding.owner.agentId, teamName: binding.owner.teamName,
  }) !== reference.ownerKey) {
    throw refusal('the resumed host session, project, or Codex profile changed')
  }
  if (binding.state !== 'ready') {
    throw refusal('the previous native request has an unconfirmed outcome')
  }
  await readCodexConversationOwnerReference(canonical.transcriptPath, binding.lastHostTurnId)
  return binding.owner
}

/** Own one direct conversation until its native child has actually stopped. */
export async function acquireCodexNativeConversation(
  params: { owner: CodexConversationOwner; flush: () => Promise<void> },
  deps: ConversationDeps = {},
): Promise<CodexNativeConversation> {
  const owner = await resolveCodexConversationOwner(params.owner)
  const ownerKey = codexConversationOwnerKey(owner)
  const directory = codexConversationDirectory(owner.transcriptPath)
  const bindingPath = path.join(directory, 'binding.json')
  const sessionsDirectory = path.join(directory, 'sessions')
  await mkdir(directory, { recursive: true, mode: 0o700 })

  const abort = new AbortController()
  let compromised: Error | undefined
  let released = false
  const assertOwned = (): void => {
    if (compromised) throw refusal(`conversation ownership was lost: ${compromised.message}`)
    if (released) throw refusal('conversation ownership was already released')
  }
  let unlock: () => Promise<void>
  try {
    // The reference is single-valued per host transcript, even when two
    // competing launches propose different agent/profile ownership keys.
    unlock = await (deps.lock ?? lock)(owner.transcriptPath, {
      lockfilePath: `${owner.transcriptPath}.codex-native.lock`,
      realpath: false,
      retries: 0,
      onCompromised: error => {
        compromised = error
        abort.abort(error)
      },
    })
  } catch {
    throw refusal('another process owns this conversation')
  }
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    await unlock()
  }

  let reservedBinding: Binding | undefined
  let createdBinding = false
  try {
    let binding: Binding | null = null
    try {
      binding = parseBinding(JSON.parse(await readFile(bindingPath, 'utf8')), ownerKey)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw refusal(
        error instanceof Error ? error.message : 'cannot read the saved binding',
      )
    }
    const reference = await (deps.readOwnerReference ?? readCodexConversationOwnerReference)(
      owner.transcriptPath, binding?.lastHostTurnId,
    )
    if (reference && (reference.ownerKey !== ownerKey || reference.sessionId !== owner.sessionId)) {
      throw refusal('the host session belongs to a different agent, project, or Codex profile')
    }
    if (reference && !binding) throw refusal('the saved native binding is missing')
    if (binding && !reference) throw refusal('the host conversation owner reference is missing')
    if (binding && binding.state !== 'ready') {
      throw refusal('the previous native request has an unconfirmed outcome')
    }

    const isNew = !binding
    createdBinding = isNew
    binding ??= {
      schemaVersion: 1, ownerKey, owner, state: 'creating', threadId: null,
      startupContextHash: null, lastHostTurnId: null,
    }
    const resumeThreadId = binding.threadId ?? undefined
    const startupContextHash = binding.startupContextHash
    const write = async (): Promise<void> => {
      assertOwned()
      await (deps.writeBinding ?? writeJsonFileAtomic)(bindingPath, binding, {
        mode: 0o600,
        assertCommitEligible: assertOwned,
      })
    }
    // A crash from this point on must not be mistaken for a legacy session.
    binding.state = resumeThreadId ? 'active' : 'creating'
    await write()
    reservedBinding = binding
    if (!reference) {
      await (deps.writeOwnerReference ?? writeCodexConversationOwnerReference)(
        owner.transcriptPath,
        { schemaVersion: 1, sessionId: owner.sessionId, ownerKey },
        { flush: params.flush, assertCommitEligible: assertOwned },
      )
    }
    await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 })
    assertOwned()

    return {
      sessionsDirectory, resumeThreadId, startupContextHash, isNew,
      signal: abort.signal, assertOwned, release,
      verifyHostTurn: async hostTurnId => {
        assertOwned()
        const reference = await (deps.readOwnerReference ?? readCodexConversationOwnerReference)(
          owner.transcriptPath, hostTurnId,
        )
        assertOwned()
        if (reference?.ownerKey !== ownerKey || reference.sessionId !== owner.sessionId) {
          throw refusal('the submitted host turn has no durable conversation owner')
        }
      },
      recordThread: async threadId => {
        assertOwned()
        if (!UUID_PATTERN.test(threadId) || (binding.threadId && binding.threadId !== threadId)) {
          throw refusal('native transport returned a different or invalid thread UUID')
        }
        binding.threadId = threadId
        binding.state = 'active'
        await write()
      },
      settle: async result => {
        assertOwned()
        // Lost transport and unconfirmed shutdown stay reserved. Never replay
        // an uncertain turn merely because the owning runtime was restarted.
        if (!result.childStopped || (result.submissionMayHaveStarted && (!result.turnTerminal || !binding.threadId))) return
        if (result.contextAdmitted && result.turnTerminal) {
          binding.startupContextHash = result.startupContextHash ?? null
          binding.lastHostTurnId = result.hostTurnId ?? null
        }
        binding.state = 'ready'
        await write()
      },
    }
  } catch (error) {
    // acquire() has not returned, so no runner can have admitted a prompt.
    // Repair only our own reservation while ownership is still intact. If a
    // partial reference cannot be read, retain it as an explicit storage error.
    if (reservedBinding && !compromised) {
      try {
        assertOwned()
        const reference = await (deps.readOwnerReference ?? readCodexConversationOwnerReference)(owner.transcriptPath)
        assertOwned()
        if (!reference && createdBinding) {
          await rm(bindingPath, { force: true })
        } else if (reference?.ownerKey === ownerKey && reference.sessionId === owner.sessionId) {
          reservedBinding.state = 'ready'
          await (deps.writeBinding ?? writeJsonFileAtomic)(bindingPath, reservedBinding, {
            mode: 0o600, assertCommitEligible: assertOwned,
          })
        }
      } catch { /* An unverifiable storage failure must remain closed. */ }
    }
    await release().catch(() => undefined)
    throw error
  }
}
