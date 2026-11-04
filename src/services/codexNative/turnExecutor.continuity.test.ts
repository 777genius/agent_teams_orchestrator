import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { getSessionId, getSessionProjectDir, switchSession } from '../../bootstrap/state.js'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import { asSessionId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { createUserMessage } from '../../utils/messages.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
import {
  hashNativeBootstrapText,
  NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV,
} from '../teamBootstrap/nativeAppManagedBootstrapContext.js'
import { acquireCodexNativeConversation } from './conversationBinding.js'
import { readCodexConversationOwnerReference } from './conversationOwnerReference.js'
import type { CodexNativeExecObservation, CodexNativeExecSummary, CodexNativeExecRunnerOptions } from './execRunner.js'
import { CodexNativeRunnerError } from './runnerLifecycle.js'
import { executeCodexNativeTurn } from './turnExecutor.js'

type Params = Parameters<typeof executeCodexNativeTurn>[0]
type Deps = NonNullable<Parameters<typeof executeCodexNativeTurn>[1]>
type BindingDeps = NonNullable<Parameters<typeof acquireCodexNativeConversation>[1]>
type Input = Pick<CodexNativeExecRunnerOptions, 'prompt' | 'resumeThreadId' | 'sessionsDirectory' | 'ephemeral' | 'model' | 'reasoningEffort'>
type Runner = (options: Input) => AsyncGenerator<CodexNativeExecObservation, CodexNativeExecSummary, unknown>
const roots: string[] = []
const envKeys = [NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV, 'CODEX_HOME', 'CLAUDE_CODE_CODEX_NATIVE_PERSIST_THREADS'] as const
let previousEnv: Record<string, string | undefined>
let previousSession: ReturnType<typeof getSessionId>
let previousProjectDir: string | null

beforeEach(() => {
  previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  previousSession = getSessionId()
  previousProjectDir = getSessionProjectDir()
  for (const key of envKeys) delete process.env[key]
})

afterEach(async () => {
  switchSession(previousSession, previousProjectDir)
  for (const key of envKeys) {
    const value = previousEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function collect(iterator: ReturnType<typeof executeCodexNativeTurn>) {
  const messages: SDKMessage[] = []
  for await (const message of iterator) messages.push(message)
  return messages
}

function summary(options: Input, threadId: string): CodexNativeExecSummary {
  return {
    identity: { executablePath: '/TEST/codex', executableSource: 'system-path', version: 'TEST' },
    threadId,
    credentialSource: 'none',
    completionPolicy: options.ephemeral ? 'ephemeral' : 'persistent',
    finalHistoryCompleteness: 'live-only',
    finalUsageAuthority: 'live-turn-completed',
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-codex-executor-continuity-'))
  roots.push(root)
  const sessionId = asSessionId(randomUUID())
  const projectDir = path.join(root, 'host')
  const cwd = path.join(root, 'project')
  const sourceProfile = path.join(root, 'profile')
  await Promise.all([mkdir(projectDir), mkdir(cwd), mkdir(sourceProfile)])
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
  switchSession(sessionId, projectDir)
  process.env.CODEX_HOME = sourceProfile
  const messages: Message[] = []
  const recorded = new Set<string>()
  const heldLocks = new Set<string>()
  const calls: Array<Input & { transport: string }> = []
  const threadId = randomUUID()
  let acquired = 0
  let enabled = true
  let sessionsDirectory: string | undefined
  let bindingOverrides: BindingDeps = {}
  const lock: NonNullable<BindingDeps['lock']> = async file => {
    if (heldLocks.has(file)) throw new Error('TEST conversation already owned')
    heldLocks.add(file)
    return async () => { heldLocks.delete(file) }
  }
  const successful: Runner = async function* (options) {
    const nativeId = options.ephemeral ? randomUUID() : options.resumeThreadId ?? threadId
    yield { type: 'normalized_event', event: { type: 'thread_started', threadId: nativeId } }
    yield { type: 'normalized_event', event: { type: 'turn_started' } }
    yield { type: 'normalized_event', event: { type: 'assistant_text', itemId: randomUUID(), text: 'TEST answer', phase: 'final_answer' } }
    yield { type: 'normalized_event', event: { type: 'turn_completed' } }
    return summary(options, nativeId)
  }
  let behavior = successful
  const runner = (transport: string): Runner => async function* (options) {
    calls.push({ ...options, transport })
    return yield* behavior(options)
  }
  const deps: Deps = {
    runExec: runner('exec'),
    runAppServer: runner('app-server'),
    isPersistenceEnabled: () => enabled,
    buildUserLoopbackProviderConfigOverrides: () => [],
    runtimeTurnSettledEmitter: { emit: async () => {} },
    flushSessionStorage: async () => {},
    // Real UUID/session-stamped JSONL rows make binding correlation observable.
    // No global module mocks or in-memory substitute for the owner reference.
    recordTranscript: async rows => {
      for (const message of rows) {
        if (recorded.has(message.uuid)) continue
        await appendFile(transcriptPath, JSON.stringify({ ...message, sessionId }) + '\n')
        recorded.add(message.uuid)
      }
      return rows.at(-1)?.uuid ?? null
    },
    acquireConversation: async params => {
      acquired++
      expect(params.owner.sessionId).toBe(sessionId)
      expect(params.owner.transcriptPath).toBe(transcriptPath)
      const conversation = await acquireCodexNativeConversation(params, { lock, ...bindingOverrides })
      sessionsDirectory = conversation.sessionsDirectory
      return conversation
    },
  }
  const start = (prompt: string, options: Partial<Params> = {}) => {
    const scope = options.conversationScope ?? 'direct'
    const user = createUserMessage({
      content: prompt,
      ...(scope === 'direct' ? {} : { isMeta: true, isSynthetic: true }),
    })
    messages.push(user)
    return executeCodexNativeTurn({
      prompt, cwd, model: 'gpt-5.3-codex', effortValue: undefined,
      permissionMode: 'bypassPermissions', additionalWritableDirectories: [],
      persistSession: true, conversationScope: scope,
      replayedUserMessages: [], transcriptMessages: messages, mutableMessages: [],
      totalUsage: structuredClone(EMPTY_USAGE), permissionDenials: [],
      initialAppState: { fastMode: false } as never,
      startTime: Date.now(),
      ...options,
    }, deps)
  }
  return {
    root, sessionId, projectDir, transcriptPath, cwd, sourceProfile, threadId,
    messages, calls, heldLocks, deps, successful, start,
    turn: (prompt: string, options: Partial<Params> = {}) => collect(start(prompt, options)),
    setRunner: (next: Runner) => { behavior = next },
    setBindingDeps: (next: BindingDeps) => { bindingOverrides = next },
    setPersistenceEnabled: (next: boolean) => { enabled = next },
    acquisitions: () => acquired,
    bindingPath: () => path.join(path.dirname(sessionsDirectory!), 'binding.json'),
  }
}

async function startupContext(root: string, contextText: string) {
  const contextPath = path.join(root, 'startup.json')
  const data = {
    schemaVersion: 1,
    kind: 'native_app_managed_bootstrap',
    mode: 'startup_context_file',
    teamName: 'TEST-team', memberName: 'nova', agentId: 'nova@TEST-team',
    runId: 'TEST-launch-only', provider: 'codex', contextText,
    contextHash: hashNativeBootstrapText(contextText),
    briefingHash: hashNativeBootstrapText('TEST briefing'),
    bootstrapProofToken: 'TEST_PRIVATE_PROOF_TOKEN', generatedAt: new Date().toISOString(),
  }
  await writeFile(contextPath, JSON.stringify(data))
  process.env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV] = contextPath
  return { contextPath, data }
}

describe('native Codex executor conversation continuity', () => {
  test.each(['bypassPermissions', 'default'] as const)('three direct %s turns reuse exact native identity and storage', async permissionMode => {
    const f = await fixture()
    for (const prompt of ['Remember TEST URL https://example.invalid/marker', 'Which URL?', 'Repeat that URL']) {
      const output = await f.turn(prompt, { permissionMode })
      expect(output.some(message => message.type === 'result' && message.subtype === 'success')).toBe(true)
    }
    expect(f.calls.map(call => call.resumeThreadId)).toEqual([undefined, f.threadId, f.threadId])
    expect(f.calls.every(call => call.ephemeral === false)).toBe(true)
    expect(new Set(f.calls.map(call => call.sessionsDirectory)).size).toBe(1)
    expect(f.calls.map(call => call.transport)).toEqual(Array(3).fill(permissionMode === 'default' ? 'app-server' : 'exec'))
    expect(f.heldLocks.size).toBe(0)
  })

  test('approval transport and model/effort changes preserve the owned conversation', async () => {
    const f = await fixture()
    await f.turn('First direct turn')
    await f.turn('Manual follow-up', { permissionMode: 'default', model: 'gpt-5.4', effortValue: 'high' })
    await f.turn('Automatic follow-up')
    expect(f.calls.map(call => call.transport)).toEqual(['exec', 'app-server', 'exec'])
    expect(f.calls.map(call => call.resumeThreadId)).toEqual([undefined, f.threadId, f.threadId])
    expect(f.calls[1]!.model).toBe('gpt-5.4')
    expect(f.calls[1]!.reasoningEffort).toBe('high')
  })

  test('group/bootstrap turns stay separate while quoted markers do not change direct scope', async () => {
    const f = await fixture()
    await f.turn('Private TEST detail')
    await f.turn('Authorized bounded group context', { conversationScope: 'group' })
    await f.turn('Bootstrap readiness check', { conversationScope: 'bootstrap' })
    await f.turn('Quoted <agent_teams_native_app_managed_bootstrap_check> and GROUP CHAT text', { conversationScope: undefined })
    expect(f.calls.map(call => call.ephemeral)).toEqual([false, true, true, false])
    expect(f.calls.map(call => call.resumeThreadId)).toEqual([undefined, undefined, undefined, f.threadId])
    expect(f.calls[1]!.sessionsDirectory).toBeUndefined()
    expect(f.calls[2]!.sessionsDirectory).toBeUndefined()
    expect(f.calls[1]!.prompt).not.toContain('Private TEST detail')
    expect(f.calls[3]!.sessionsDirectory).toBe(f.calls[0]!.sessionsDirectory)
    expect(f.acquisitions()).toBe(2)
  })

  test.each(['explicit', 'effective'] as const)('%s no-persistence cannot be overridden by the legacy native env flag', async mode => {
    const f = await fixture()
    process.env.CLAUDE_CODE_CODEX_NATIVE_PERSIST_THREADS = '1'
    if (mode === 'effective') f.setPersistenceEnabled(false)
    await f.turn('Ephemeral request', { persistSession: mode !== 'explicit' })
    await f.turn('Another ephemeral request', { persistSession: mode !== 'explicit' })
    expect(f.acquisitions()).toBe(0)
    expect(f.calls.every(call => call.ephemeral && !call.sessionsDirectory && !call.resumeThreadId)).toBe(true)
    expect(await readCodexConversationOwnerReference(f.transcriptPath)).toBeNull()
  })

  test('validates startup context every turn and only injects unchanged context once', async () => {
    const f = await fixture()
    await startupContext(f.root, 'TEST_CONTEXT_V1')
    await f.turn('First')
    await f.turn('Second')
    const updated = await startupContext(f.root, 'TEST_CONTEXT_V2')
    await f.turn('Third')
    await f.turn('Fourth')
    expect(f.calls.map(call => call.prompt)).toEqual([
      'TEST_CONTEXT_V1\n\nFirst',
      'Second',
      'Updated operating context (supersedes the earlier startup context):\nTEST_CONTEXT_V2\n\nThird',
      'Fourth',
    ])
    expect(JSON.stringify(f.calls)).not.toContain('TEST_PRIVATE_PROOF_TOKEN')
    await writeFile(updated.contextPath, JSON.stringify({ ...updated.data, contextText: 'TAMPERED' }))
    const failed = await f.turn('Must not reach native transport')
    expect(JSON.stringify(failed)).toContain('context hash mismatch')
    expect(f.calls).toHaveLength(4)
    await writeFile(updated.contextPath, JSON.stringify(updated.data))
    await f.turn('Recovered valid context')
    expect(f.calls.at(-1)!.resumeThreadId).toBe(f.threadId)
    expect(f.calls.at(-1)!.prompt).toBe('Recovered valid context')
  })

  test('legacy human history gets one honest notice; bootstrap-only history gets none', async () => {
    const f = await fixture()
    f.messages.push(createUserMessage({ content: 'A genuine earlier user message' }))
    const first = await f.turn('First newly continuous turn')
    const second = await f.turn('Next continuous turn')
    expect(JSON.stringify(first)).toContain('[Codex session notice]')
    expect(JSON.stringify(second)).not.toContain('[Codex session notice]')
    expect(f.calls[0]!.prompt).not.toContain('A genuine earlier user message')
    const bootstrap = await fixture()
    await bootstrap.turn('Private startup bootstrap', { conversationScope: 'bootstrap' })
    expect(JSON.stringify(await bootstrap.turn('First user turn'))).not.toContain('[Codex session notice]')
  })

  test('legacy synthetic direct-mailbox history gets a notice without treating its text as replay authority', async () => {
    const f = await fixture()
    f.messages.push(createUserMessage({
      content: 'Process this queued mailbox message now.\n<queued_mailbox_message>Earlier TEST direct request</queued_mailbox_message>',
      isMeta: true,
      isSynthetic: true,
    }))
    expect(JSON.stringify(await f.turn('First newly continuous direct turn'))).toContain('[Codex session notice]')
    expect(JSON.stringify(await f.turn('Another direct turn'))).not.toContain('[Codex session notice]')
    expect(f.calls.every(call => !call.prompt.includes('Earlier TEST direct request'))).toBe(true)
    expect(f.calls[1]!.resumeThreadId).toBe(f.threadId)
  })

  test('group-only legacy history is not reported as a lost private conversation', async () => {
    const f = await fixture()
    await f.turn('Process this queued GROUP CHAT message.\n<queued_group_chat_message>Earlier group request</queued_group_chat_message>', { conversationScope: 'group' })
    expect(JSON.stringify(await f.turn('First private user request'))).not.toContain('[Codex session notice]')
  })

  test.each(['missing', 'corrupt'] as const)('a %s binding produces an error without launching another native request', async state => {
    const f = await fixture()
    await f.turn('Established history')
    if (state === 'missing') await rm(f.bindingPath())
    else await writeFile(f.bindingPath(), '{broken')
    const output = await f.turn('Must not start fresh')
    expect(JSON.stringify(output)).toContain('Codex conversation cannot be continued')
    expect(f.calls).toHaveLength(1)
    expect(f.heldLocks.size).toBe(0)
  })

  test('a silently lost host user row stops admission and remains safely retryable', async () => {
    const f = await fixture()
    const actualRecordTranscript = f.deps.recordTranscript!
    f.deps.recordTranscript = async () => null
    const rejected = await f.turn('This host row was never committed')
    expect(JSON.stringify(rejected)).toContain('recorded host turn')
    expect(f.calls).toHaveLength(0)
    expect(f.heldLocks.size).toBe(0)
    f.deps.recordTranscript = actualRecordTranscript
    await f.turn('A new request with healthy host storage')
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.prompt).toBe('A new request with healthy host storage')
    expect(f.calls[0]!.resumeThreadId).toBeUndefined()
  })

  test.each(['pre-submit', 'terminal', 'unconfirmed-shutdown'] as const)('uses typed %s evidence to decide whether a NEW request may resume', async failure => {
    const f = await fixture()
    f.setRunner(async function* (options) {
      if (failure !== 'pre-submit') {
        yield { type: 'normalized_event', event: { type: 'thread_started', threadId: f.threadId } }
        yield { type: 'normalized_event', event: { type: 'turn_started' } }
      }
      throw new CodexNativeRunnerError(`TEST ${failure}`, {
        submissionMayHaveStarted: failure !== 'pre-submit',
        turnTerminal: failure !== 'pre-submit',
        childStopped: failure !== 'unconfirmed-shutdown',
      })
    })
    expect(JSON.stringify(await f.turn('Failure request'))).toContain(`TEST ${failure}`)
    f.setRunner(f.successful)
    const next = await f.turn('A different new request')
    if (failure === 'unconfirmed-shutdown') {
      expect(JSON.stringify(next)).toContain('unconfirmed outcome')
      expect(f.calls).toHaveLength(1)
    } else {
      expect(f.calls).toHaveLength(2)
      expect(f.calls[1]!.resumeThreadId).toBe(failure === 'terminal' ? f.threadId : undefined)
      expect(f.calls[1]!.prompt).toBe('A different new request')
    }
    expect(f.heldLocks.size).toBe(0)
  })

  test('a transient identity write failure before app-server admission permits exact-thread recovery', async () => {
    const f = await fixture()
    await startupContext(f.root, 'TEST_CONTEXT_NOT_YET_ADMITTED')
    let failIdentityWrite = true
    f.setBindingDeps({
      writeBinding: async (file, value, options) => {
        if (failIdentityWrite && (value as { state?: string }).state === 'active') {
          failIdentityWrite = false
          throw new Error('TEST identity write failed')
        }
        await writeJsonFileAtomic(file, value, options)
      },
    })
    let submitted = 0
    let stopped = 0
    f.setRunner(async function* (options) {
      try {
        yield { type: 'normalized_event', event: { type: 'thread_started', threadId: f.threadId } }
        submitted++
        yield { type: 'normalized_event', event: { type: 'turn_started' } }
        yield { type: 'normalized_event', event: { type: 'assistant_text', itemId: randomUUID(), text: 'TEST recovered' } }
        yield { type: 'normalized_event', event: { type: 'turn_completed' } }
        return summary(options, f.threadId)
      } finally { stopped++ }
    })
    expect(JSON.stringify(await f.turn('Never admitted', { permissionMode: 'default' }))).toContain('TEST identity write failed')
    expect(submitted).toBe(0)
    expect(stopped).toBe(1)
    expect(f.heldLocks.size).toBe(0)
    expect(JSON.parse(await readFile(f.bindingPath(), 'utf8')).startupContextHash).toBeNull()
    await f.turn('A new request after storage recovery', { permissionMode: 'default' })
    expect(submitted).toBe(1)
    expect(stopped).toBe(2)
    expect(f.calls[1]!.resumeThreadId).toBe(f.threadId)
    expect(f.calls[1]!.prompt).toBe('TEST_CONTEXT_NOT_YET_ADMITTED\n\nA new request after storage recovery')
  })

  test.each(['identity', 'terminal'] as const)('a normal runner return without %s confirmation cannot enable a fresh fallback', async missing => {
    const f = await fixture()
    f.setRunner(async function* (options) {
      if (missing !== 'identity') yield { type: 'normalized_event', event: { type: 'thread_started', threadId: f.threadId } }
      yield { type: 'normalized_event', event: { type: 'turn_started' } }
      yield { type: 'normalized_event', event: { type: 'assistant_text', itemId: randomUUID(), text: 'TEST incomplete native evidence' } }
      if (missing !== 'terminal') yield { type: 'normalized_event', event: { type: 'turn_completed' } }
      return summary(options, f.threadId)
    })
    expect(JSON.stringify(await f.turn('Unconfirmed request'))).toContain('without confirming the owned thread')
    f.setRunner(f.successful)
    expect(JSON.stringify(await f.turn('A new request must be refused'))).toContain('unconfirmed outcome')
    expect(f.calls).toHaveLength(1)
  })

  test('consumer early return waits for native cleanup before releasing ownership', async () => {
    const f = await fixture()
    let releaseShutdown!: () => void
    let shutdownStarted!: () => void
    const barrier = new Promise<void>(resolve => { releaseShutdown = resolve })
    const started = new Promise<void>(resolve => { shutdownStarted = resolve })
    f.setRunner(async function* (options) {
      try {
        yield { type: 'normalized_event', event: { type: 'thread_started', threadId: f.threadId } }
        yield { type: 'normalized_event', event: { type: 'turn_started' } }
        yield { type: 'normalized_event', event: { type: 'assistant_text', itemId: 'partial', text: 'TEST partial answer' } }
        yield { type: 'normalized_event', event: { type: 'turn_completed' } }
        return summary(options, f.threadId)
      } finally {
        shutdownStarted()
        await barrier
      }
    })
    const iterator = f.start('Interrupted consumer')
    let next = await iterator.next()
    while (!next.done && next.value.type !== 'assistant') next = await iterator.next()
    expect(next.done).toBe(false)
    const closing = iterator.return(undefined as never)
    await started
    expect(f.heldLocks.size).toBe(1)
    releaseShutdown()
    await closing
    expect(f.heldLocks.size).toBe(0)
    expect(JSON.parse(await readFile(f.bindingPath(), 'utf8')).state).toBe('active')
    f.setRunner(f.successful)
    expect(JSON.stringify(await f.turn('Do not replay the interrupted prompt'))).toContain('unconfirmed outcome')
    expect(f.calls).toHaveLength(1)
  })

  test('a session switch during the native turn cannot write old output to its successor', async () => {
    const f = await fixture()
    const successorId = asSessionId(randomUUID())
    const successorPath = path.join(f.projectDir, `${successorId}.jsonl`)
    f.setRunner(async function* (options) {
      yield { type: 'normalized_event', event: { type: 'thread_started', threadId: f.threadId } }
      yield { type: 'normalized_event', event: { type: 'turn_started' } }
      switchSession(successorId, f.projectDir)
      yield { type: 'normalized_event', event: { type: 'assistant_text', itemId: 'old-turn', text: 'OLD_SESSION_OUTPUT' } }
      return summary(options, f.threadId)
    })
    await expect(f.turn('Old session request')).rejects.toThrow('host conversation changed')
    expect(f.heldLocks.size).toBe(0)
    expect(await readCodexConversationOwnerReference(successorPath)).toBeNull()
    expect(await readFile(f.transcriptPath, 'utf8')).not.toContain('OLD_SESSION_OUTPUT')
    expect(f.messages.some(message => JSON.stringify(message).includes('OLD_SESSION_OUTPUT'))).toBe(false)
  })
})
