import { expect, test } from 'bun:test'

import {
  findOrdinaryDirectReplyFallback,
  getOrdinaryPendingMessage,
  getOrdinaryProcessingAction,
  getProcessingOrdinaryMessage,
} from '../../hooks/useInboxPoller.js'
import {
  createUserMessage,
  handleMessageFromStream,
  isNotEmptyMessage,
} from '../../utils/messages.js'
import { runCodexNativeTurnInRepl } from './replTurnBridge.js'
import { executeCodexNativeTurn } from './turnExecutor.js'
import {
  cleanMessagesForLogging,
  isChainParticipant,
} from '../../utils/sessionStorage.js'

test('mixed native turn keeps live transcript order and its final parent after an initial empty assistant', async () => {
  const submitted = createUserMessage({
    content: 'TEST mixed peer',
    isMeta: true,
  })
  const live = [submitted] as Parameters<
    typeof getOrdinaryProcessingAction
  >[0]['messages']
  let projected: typeof live = []
  await runCodexNativeTurnInRepl(
    {
      prompt: 'TEST mixed peer',
      cwd: '/tmp/TEST-mixed-peer',
      model: 'gpt-5.4',
      effortValue: undefined,
      permissionMode: 'bypassPermissions',
      additionalWritableDirectories: [],
      initialAppState: { fastMode: false } as never,
      transcriptMessages: live,
      requestApproval: async () => ({ allow: false }),
      onReplEvent: (event) =>
        handleMessageFromStream(
          event,
          (message) => live.push(message),
          () => {},
          () => {},
          () => {},
        ),
    },
    {
      executeTurn: (params) => {
        projected = params.transcriptMessages
        return executeCodexNativeTurn(
          { ...params, persistSession: false },
          {
            buildUserLoopbackProviderConfigOverrides: () => [],
            runtimeTurnSettledEmitter: { emit: async () => {} },
            runExec: async function* () {
              yield {
                type: 'normalized_event',
                event: { type: 'assistant_text', itemId: 'empty', text: '' },
              }
              yield { type: 'normalized_event', event: { type: 'assistant_text', itemId: 'commentary', phase: 'commentary', text: 'I will read the instructions first.' } }
              yield {
                type: 'normalized_event',
                event: {
                  type: 'tool_call_started',
                  itemId: 'tool-1',
                  toolSource: 'native',
                  toolName: 'TEST tool',
                  arguments: {},
                  status: 'running',
                  rawItemType: 'command_execution',
                },
              }
              yield {
                type: 'normalized_event',
                event: {
                  type: 'tool_call_completed',
                  itemId: 'tool-1',
                  toolSource: 'native',
                  toolName: 'TEST tool',
                  arguments: {},
                  status: 'completed',
                  rawItemType: 'command_execution',
                  resultText: 'TEST result',
                  rawResult: {},
                  errorMessage: null,
                  isError: false,
                },
              }
              yield {
                type: 'normalized_event',
                event: {
                  type: 'assistant_text',
                  itemId: 'final',
                  phase: 'final_answer',
                  text: 'TEST final response',
                },
              }
              yield {
                type: 'normalized_event',
                event: { type: 'turn_completed' },
              }
              return {
                identity: {
                  executablePath: '/TEST/codex',
                  executableSource: 'system-path',
                  version: 'codex-cli TEST',
                },
                threadId: null,
                credentialSource: 'ambient-process-env',
                completionPolicy: 'ephemeral',
                finalHistoryCompleteness: 'live-only',
                finalUsageAuthority: 'live-turn-completed',
              }
            },
          },
        )
      },
    },
  )
  expect(
    projected.some(
      (message) => message.type === 'assistant' && !isNotEmptyMessage(message),
    ),
  ).toBe(true)
  expect(live.map((message) => message.type)).toEqual([
    'user',
    'assistant',
    'assistant',
    'user',
    'assistant',
  ])
  expect(
    live.some(
      (message) => message.type === 'assistant' && !isNotEmptyMessage(message),
    ),
  ).toBe(false)
  const final = live.at(-1)!
  expect(final).toMatchObject({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'TEST final response' }] },
  })
  expect(findOrdinaryDirectReplyFallback({ messages: live, submitUserMessageUuid: submitted.uuid, excludeNativeCommentary: true })).toEqual({ text: 'TEST final response' })
  expect(findOrdinaryDirectReplyFallback({ messages: live, submitUserMessageUuid: submitted.uuid })?.text).toContain('I will read the instructions first.')
  // Same parent selection used by useLogMessages for the following user turn.
  expect(
    cleanMessagesForLogging(live, live).findLast(isChainParticipant)?.uuid,
  ).toBe(final.uuid)
})

test('completed empty native peer turn reaches the live REPL mailbox without a provider replay', async () => {
  const submitted = createUserMessage({
    content: 'peer acknowledgement',
    isMeta: true,
  })
  const live = [submitted] as Parameters<
    typeof getOrdinaryProcessingAction
  >[0]['messages']
  let providerSubmissions = 0
  let projected: typeof live = []
  const runNative = (prompt: string) =>
    runCodexNativeTurnInRepl(
      {
        prompt,
        cwd: '/tmp/TEST-empty-peer',
        model: 'gpt-5.4',
        effortValue: undefined,
        permissionMode: 'bypassPermissions',
        additionalWritableDirectories: [],
        initialAppState: { fastMode: false } as never,
        transcriptMessages: live,
        requestApproval: async () => ({ allow: false }),
        onReplEvent: (event) =>
          handleMessageFromStream(
            event,
            (message) => live.push(message),
            () => {},
            () => {},
            () => {},
          ),
      },
      {
        executeTurn: (params) => {
          projected = params.transcriptMessages
          return executeCodexNativeTurn(
            { ...params, persistSession: false },
            {
              buildUserLoopbackProviderConfigOverrides: () => [],
              runtimeTurnSettledEmitter: { emit: async () => {} },
              runExec: async function* () {
                providerSubmissions++
                yield {
                  type: 'normalized_event',
                  event: { type: 'assistant_text', itemId: 'empty', text: '' },
                }
                yield {
                  type: 'normalized_event',
                  event: { type: 'turn_completed' },
                }
                return {
                  identity: {
                    executablePath: '/TEST/codex',
                    executableSource: 'system-path',
                    version: 'codex-cli TEST',
                  },
                  threadId: null,
                  credentialSource: 'ambient-process-env',
                  completionPolicy: 'ephemeral',
                  finalHistoryCompleteness: 'live-only',
                  finalUsageAuthority: 'live-turn-completed',
                }
              },
            },
          )
        },
      },
    )
  await runNative('peer acknowledgement')
  const attempt = {
    submitUserMessageUuid: submitted.uuid,
    submittedAt: 1,
    cooldownUntil: 0,
    status: 'in_flight' as const,
    timer: null,
  }
  const peer = {
    id: 'peer-row',
    messageId: 'peer-message',
    mailboxClaimedBySessionId: 'TEST-session',
    from: 'jack',
    text: 'ack',
    timestamp: '2026-10-23T00:54:35.028Z',
    status: 'processing' as const,
  }
  expect(
    getOrdinaryProcessingAction({
      attempt,
      messages: live,
      processingOrdinaryMessage: peer,
      now: 200_000,
    }),
  ).toEqual({ type: 'finalize' })
  expect(providerSubmissions).toBe(1)
  expect(live.filter((message) => message.type === 'assistant')).toHaveLength(1)
  expect(live.find((message) => message.type === 'assistant')?.uuid).toBe(
    projected.find((message) => message.type === 'assistant')?.uuid,
  )
  expect(live.filter(isNotEmptyMessage)).toEqual([submitted])
  // A receipt is activity, not the visible reply a direct human request requires.
  expect(
    getOrdinaryProcessingAction({
      attempt,
      messages: live,
      processingOrdinaryMessage: { ...peer, from: 'user' },
      now: 200_000,
    }).type,
  ).toBe('schedule_cooldown')
  expect(
    getOrdinaryProcessingAction({
      attempt,
      messages: live,
      processingOrdinaryMessage: {
        ...peer,
        messageKind: 'member_work_sync_nudge',
      },
      now: 200_000,
    }).type,
  ).not.toBe('finalize')
  expect(
    getOrdinaryProcessingAction({
      attempt: { ...attempt, submitUserMessageUuid: 'foreign-submit' },
      messages: live,
      processingOrdinaryMessage: peer,
      now: 2,
    }).type,
  ).toBe('noop')
  const laterTask = {
    ...peer,
    id: 'new-task-row',
    messageId: 'new-task',
    from: 'user',
    source: 'system_notification',
    status: 'pending' as const,
  }
  const rows = [{ ...peer, status: 'processed' as const }, laterTask]
  expect(
    getProcessingOrdinaryMessage({
      messages: rows,
      getAttemptStatus: () => undefined,
    }),
  ).toBeUndefined()
  expect(
    getOrdinaryPendingMessage({
      pendingMessages: rows.filter((row) => row.status === 'pending'),
    }),
  ).toBe(laterTask)
  live.push(createUserMessage({ content: laterTask.text, isMeta: true }))
  await runNative(laterTask.text)
  expect(providerSubmissions).toBe(2)
  const assistants = live.filter((message) => message.type === 'assistant')
  expect(assistants).toHaveLength(2)
  expect(new Set(assistants.map((message) => message.uuid)).size).toBe(2)
})

test.each(['error', 'cancelled'] as const)(
  'does not expose an empty native receipt after %s',
  async (outcome) => {
    const live: Parameters<typeof getOrdinaryProcessingAction>[0]['messages'] =
      []
    const controller = new AbortController()
    await runCodexNativeTurnInRepl(
      {
        prompt: 'TEST peer',
        cwd: '/tmp/TEST-empty-peer',
        model: 'gpt-5.4',
        effortValue: undefined,
        permissionMode: 'bypassPermissions',
        additionalWritableDirectories: [],
        initialAppState: { fastMode: false } as never,
        transcriptMessages: live,
        abortSignal: controller.signal,
        requestApproval: async () => ({ allow: false }),
        onReplEvent: (event) => {
          if (event.type !== 'stream_event') live.push(event)
        },
      },
      {
        executeTurn: (params) =>
          executeCodexNativeTurn(
            { ...params, persistSession: false },
            {
              buildUserLoopbackProviderConfigOverrides: () => [],
              runtimeTurnSettledEmitter: { emit: async () => {} },
              runExec: async function* () {
                yield {
                  type: 'normalized_event',
                  event: { type: 'assistant_text', itemId: 'empty', text: '' },
                }
                if (outcome === 'error')
                  throw new Error('TEST native execution failed')
                controller.abort()
                yield {
                  type: 'normalized_event',
                  event: { type: 'turn_completed' },
                }
                return {
                  identity: {
                    executablePath: '/TEST/codex',
                    executableSource: 'system-path',
                    version: 'codex-cli TEST',
                  },
                  threadId: null,
                  credentialSource: 'ambient-process-env',
                  completionPolicy: 'ephemeral',
                  finalHistoryCompleteness: 'live-only',
                  finalUsageAuthority: 'live-turn-completed',
                }
              },
            },
          ),
      },
    )
    expect(
      live.some(
        (message) =>
          message.type === 'assistant' && !isNotEmptyMessage(message),
      ),
    ).toBe(false)
  },
)
