import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from '../../Tool.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import { createPermissionContext } from '../../hooks/toolPermission/PermissionContext.js'
import { handleInteractivePermission } from '../../hooks/toolPermission/handlers/interactiveHandler.js'
import { handleSwarmWorkerPermission } from '../../hooks/toolPermission/handlers/swarmWorkerHandler.js'
import {
  hasPermissionCallback,
  processMailboxPermissionResponse,
  unregisterPermissionCallback,
} from '../../hooks/useSwarmPermissionPoller.js'
import type { AppState } from '../../state/AppState.js'
import { getDynamicTeamContext, setDynamicTeamContext } from '../../utils/teammate.js'
import { readMailbox } from '../../utils/teammateMailbox.js'
import type { Message, StreamEvent } from '../../types/message.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
import type { CodexAppServerApprovalDecision, CodexManualTurnStartParams } from './appServerApproval.js'
import { runCodexNativeAppServer } from './appServerRunner.js'
import { createCodexAppServerApprovalPromptHandler } from './approvalPromptBridge.js'
import { runCodexNativeTurnInRepl } from './replTurnBridge.js'
import { executeCodexNativeTurn } from './turnExecutor.js'

interface RpcMessage {
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message: string }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createApprovalServer(cwd: string, completeOnDecision = true) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const sent: RpcMessage[] = []
  const writeErrors: Error[] = []
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 0,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill() {
      this.killed = true
      this.exitCode = 0
      this.emit('exit', 0, null)
      return true
    },
  })
  const write = (payload: RpcMessage) =>
    stdout.write(`${JSON.stringify(payload)}\n`)
  const complete = () => {
    write({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-test',
        turnId: 'turn-test',
        itemId: 'answer',
        delta: 'Done',
      },
    })
    write({
      method: 'turn/completed',
      params: {
        threadId: 'thread-test',
        turn: { id: 'turn-test', status: 'completed' },
      },
    })
  }
  stdin.on('error', error => writeErrors.push(error))
  // Capture attempted writes as well as data so writes after end are observable.
  const originalWrite = stdin.write.bind(stdin)
  stdin.write = ((chunk: string, ...args: unknown[]) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) sent.push(JSON.parse(line) as RpcMessage)
    }
    return Reflect.apply(originalWrite, stdin, [chunk, ...args])
  }) as typeof stdin.write
  stdin.on('data', chunk => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as RpcMessage
      if (!message.method) {
        if (message.id === 'approval-test' && completeOnDecision) complete()
        continue
      }
      if (message.id === undefined) continue
      write({
        id: message.id,
        result: message.method === 'thread/start'
          ? { thread: { id: 'thread-test' } }
          : message.method === 'turn/start'
            ? { turn: { id: 'turn-test' } }
            : {},
      })
      if (message.method === 'turn/start') {
        write({
          id: 'approval-test',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-test',
            turnId: 'turn-test',
            itemId: 'command-test',
            command: 'printf sandbox-test',
            cwd,
            reason: 'Synthetic approval',
          },
        })
      }
    }
  })
  const deps = {
    which: () => '/synthetic-test/codex',
    resolveVersion: () => 'synthetic-test',
    spawnProcess: (
      _command: string,
      _args: string[],
      options: { signal?: AbortSignal },
    ) => {
      options.signal?.addEventListener('abort', () => {
        if (child.listenerCount('error') > 0) {
          child.emit('error', options.signal?.reason ?? new Error('Cancelled'))
        }
      }, { once: true })
      return child as never
    },
  }
  return { child, stdin, sent, writeErrors, complete, deps }
}

async function drain(iterator: AsyncGenerator<unknown, unknown, unknown>) {
  for await (const _observation of iterator) {
    // Consume the transport through completion or failure.
  }
}

const flushCallbacks = () => new Promise<void>(resolve => setImmediate(resolve))

describe('native REPL approval transport', () => {
  test('preserves structured attachment order through the executor and actual turn/start request', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'repl-ordered-input-test-'))
    const fake = createApprovalServer(cwd)
    let observedOptions: Parameters<typeof runCodexNativeAppServer>[0] | undefined
    const prompt = [
      { type: 'text', text: 'protocol\n' },
      { type: 'image', source: { type: 'file', path: path.join(cwd, 'first.png') } },
      { type: 'text', text: 'Attached file: note.txt\n\nПривіт 世界\n' },
      { type: 'image', source: { type: 'file', path: path.join(cwd, 'last.png') } },
    ]
    try {
      await drain(executeCodexNativeTurn({
        prompt: prompt as unknown as Parameters<typeof executeCodexNativeTurn>[0]['prompt'],
        cwd,
        model: 'gpt-5.4',
        effortValue: undefined,
        permissionMode: 'default',
        additionalWritableDirectories: [],
        initialAppState: { fastMode: false } as never,
        transcriptMessages: [],
        persistSession: false,
        replayedUserMessages: [],
        mutableMessages: [],
        totalUsage: EMPTY_USAGE,
        permissionDenials: [],
        startTime: Date.now(),
        requestApproval: async () => ({ allow: true }),
      }, {
        buildUserLoopbackProviderConfigOverrides: () => [],
        runAppServer: options => {
          observedOptions = options
          return runCodexNativeAppServer({ ...options, extraEnv: { CODEX_HOME: cwd } }, fake.deps)
        },
      }))
      expect(observedOptions?.prompt).toBe('protocol\n\nAttached file: note.txt\n\nПривіт 世界')
      expect(observedOptions?.imagePaths).toEqual([path.join(cwd, 'first.png'), path.join(cwd, 'last.png')])
      const expectedInput: CodexManualTurnStartParams['input'] = [
        { type: 'text', text: 'protocol\n', text_elements: [] },
        { type: 'localImage', path: path.join(cwd, 'first.png') },
        { type: 'text', text: 'Attached file: note.txt\n\nПривіт 世界\n', text_elements: [] },
        { type: 'localImage', path: path.join(cwd, 'last.png') },
      ]
      expect(observedOptions?.input).toEqual(expectedInput)
      expect(fake.sent.find(message => message.method === 'turn/start')?.params?.input).toEqual(expectedInput)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  for (const allow of [true, false]) {
    test(`routes ${allow ? 'allow' : 'deny'} through the scoped prompt and actual executor`, async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'repl-approval-test-'))
      const fake = createApprovalServer(cwd)
      const observed: Array<{
        name: string
        context: ToolUseContext
        force: string | undefined
      }> = []
      const context = {
        abortController: new AbortController(),
        getAppState: () => ({ fastMode: false }) as never,
      } as unknown as ToolUseContext
      const events: (Message | StreamEvent)[] = []
      const requestApproval = createCodexAppServerApprovalPromptHandler({
        toolUseContext: context,
        canUseTool: async (
          tool,
          input,
          toolContext,
          _message,
          _toolUseId,
          forceDecision,
        ): Promise<PermissionDecision> => {
          observed.push({
            name: tool.name,
            context: toolContext,
            force: forceDecision?.behavior,
          })
          return allow
            ? { behavior: 'allow', updatedInput: input }
            : {
                behavior: 'deny',
                message: 'Denied by test',
                decisionReason: { type: 'other', reason: 'Denied by test' },
              }
        },
      })
      try {
        const params = {
          prompt: 'Synthetic permission test',
          cwd,
          model: 'gpt-5.4',
          effortValue: undefined,
          permissionMode: 'default' as const,
          additionalWritableDirectories: [],
          initialAppState: { fastMode: false } as never,
          transcriptMessages: [],
          requestApproval,
          onReplEvent: (event: Message | StreamEvent) => events.push(event),
        }
        await runCodexNativeTurnInRepl(params, {
          executeTurn: turn => executeCodexNativeTurn({ ...turn, persistSession: false }, {
            buildUserLoopbackProviderConfigOverrides: () => [],
            runAppServer: options => runCodexNativeAppServer({
              ...options,
              extraEnv: { CODEX_HOME: cwd },
            }, fake.deps),
          }),
        })
        expect(
          fake.sent.find(message => message.id === 'approval-test')?.error?.message,
        ).toBeUndefined()
        expect(observed).toMatchObject([{ name: 'Bash', force: 'ask' }])
        expect(observed[0]?.context.abortController).not.toBe(context.abortController)
        expect(observed[0]?.context.getAppState).toBe(context.getAppState)
        observed[0]?.context.abortController.abort()
        expect(context.abortController.signal.aborted).toBe(false)
        expect(fake.sent.find(message => message.id === 'approval-test')).toMatchObject({
          result: { decision: allow ? 'accept' : 'decline' },
        })
        expect(fake.sent.find(message => message.method === 'thread/start')?.params).toMatchObject({
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox: 'read-only',
        })
        expect(fake.sent.find(message => message.method === 'turn/start')?.params).toMatchObject({
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
        })
        expect(events.some(event => event.type === 'assistant' && event.error)).toBe(false)
        expect(events.some(event =>
          event.type === 'assistant' && event.message.content.some(block =>
            block.type === 'text' && block.text === 'Done',
          ),
        )).toBe(true)
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    })
  }

  for (const stop of ['cancel', 'user cancel', 'completed turn', 'shutdown', 'process error', 'idle timeout'] as const) {
    test(`settles the real permission prompt and removes its queue entry after ${stop}`, async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'repl-prompt-cancellation-test-'))
      const fake = createApprovalServer(cwd, false)
      const parentController = new AbortController()
      const queue: ToolUseConfirm[] = []
      const opened = deferred<void>()
      let promptSettled = false
      const context = { abortController: parentController } as ToolUseContext
      const promptHandler = createCodexAppServerApprovalPromptHandler({
        toolUseContext: context,
        canUseTool: (tool, input, toolContext, message, toolUseId) =>
          new Promise<PermissionDecision>(resolve => {
            const permissionContext = createPermissionContext(
              tool,
              input,
              toolContext,
              message,
              toolUseId,
              () => {},
              {
                push: item => queue.push(item),
                remove: id => {
                  const index = queue.findIndex(item => item.toolUseID === id)
                  if (index !== -1) queue.splice(index, 1)
                },
                update: () => {},
              },
            )
            handleInteractivePermission({
              ctx: permissionContext,
              description: 'Synthetic permission prompt',
              result: { behavior: 'ask', message: 'Synthetic approval' },
              awaitAutomatedChecksBeforeDialog: true,
            }, resolve)
            opened.resolve()
          }).finally(() => { promptSettled = true }),
      })
      try {
        const running = drain(runCodexNativeAppServer({
          prompt: 'Synthetic prompt cancellation test',
          cwd,
          extraEnv: { CODEX_HOME: cwd },
          abortSignal: parentController.signal,
          idleTimeoutMs: stop === 'idle timeout' ? 10 : null,
          requestApproval: promptHandler,
        }, fake.deps)).then(() => null, error => error as Error)
        await opened.promise
        expect(queue).toHaveLength(1)
        if (stop === 'cancel') parentController.abort(new Error('Synthetic cancellation'))
        if (stop === 'user cancel') {
          // The UI owns removal when the user dismisses the visible dialog.
          const visiblePrompt = queue.shift()
          visiblePrompt?.onAbort()
        }
        if (stop === 'completed turn') fake.complete()
        if (stop === 'process error') fake.child.emit('error', new Error('Synthetic pipe failure'))
        if (stop === 'shutdown') {
          fake.child.exitCode = 1
          fake.child.emit('exit', 1, null)
        }
        const failure = await running
        await flushCallbacks()
        if (stop === 'completed turn') expect(failure).toBeNull()
        else expect(failure).toBeInstanceOf(Error)
        expect(queue).toHaveLength(0)
        expect(promptSettled).toBe(true)
        expect(parentController.signal.aborted).toBe(
          stop === 'cancel' || stop === 'user cancel',
        )
        expect(fake.sent.filter(message => message.id === 'approval-test')).toEqual([])
        expect(fake.writeErrors).toEqual([])
      } finally {
        // Tear down the intentionally pending old-code prompt after red assertions.
        for (const item of queue) item.onAbort()
        await rm(cwd, { recursive: true, force: true })
      }
    })
  }

  test('unregisters a real swarm permission callback after app-server shutdown', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'repl-swarm-cancellation-test-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousUserType = process.env.USER_TYPE
    const previousTeamContext = getDynamicTeamContext()
    const teamName = 'synthetic-approval-test'
    const fake = createApprovalServer(fixture, false)
    const parentController = new AbortController()
    const opened = deferred<void>()
    let appState = { pendingWorkerRequest: null } as AppState
    let requestId: string | undefined
    let promptSettled = false
    try {
      process.env.CLAUDE_CONFIG_DIR = fixture
      process.env.USER_TYPE = 'ant'
      setDynamicTeamContext({
        agentId: 'synthetic-worker-id',
        agentName: 'synthetic-worker',
        teamName,
        planModeRequired: false,
      })
      const teamDir = path.join(fixture, 'teams', teamName)
      await mkdir(teamDir, { recursive: true })
      await writeFile(path.join(teamDir, 'config.json'), JSON.stringify({
        leadAgentId: 'synthetic-leader-id',
        members: [{ agentId: 'synthetic-leader-id', name: 'team-lead' }],
      }))
      const context = {
        abortController: parentController,
        getAppState: () => appState,
        setAppState: (update: (state: AppState) => AppState) => {
          appState = update(appState)
          if (appState.pendingWorkerRequest) opened.resolve()
        },
      } as ToolUseContext
      const handler = createCodexAppServerApprovalPromptHandler({
        toolUseContext: context,
        canUseTool: async (tool, input, toolContext, message, toolUseId) => {
          const ctx = createPermissionContext(
            tool, input, toolContext, message, toolUseId, () => {},
          )
          const result = await handleSwarmWorkerPermission({
            ctx,
            description: 'Synthetic swarm approval',
            updatedInput: undefined,
            suggestions: undefined,
          })
          if (!result) throw new Error('Synthetic swarm permission handler did not engage')
          return result
        },
      })
      const running = drain(runCodexNativeAppServer({
        prompt: 'Synthetic swarm cancellation test',
        cwd: fixture,
        extraEnv: { CODEX_HOME: fixture },
        abortSignal: parentController.signal,
        requestApproval: (approval, signal) => handler(approval, signal)
          .finally(() => { promptSettled = true }),
      }, fake.deps)).then(() => null, error => error as Error)
      await opened.promise
      // The pending indicator precedes the asynchronous mailbox write. Wait for
      // publication, yielding real timer turns, with budget left for shutdown.
      const mailboxDeadline = performance.now() + 2_000
      while (!requestId && !promptSettled && performance.now() < mailboxDeadline) {
        const messages = await readMailbox('team-lead', teamName)
        const request = messages.map(message => JSON.parse(message.text) as {
          type?: string
          request_id?: string
        }).find(message => message.type === 'permission_request')
        requestId = request?.request_id
        if (!requestId) {
          const remainingMs = mailboxDeadline - performance.now()
          if (remainingMs > 0) await new Promise<void>(resolve => setTimeout(resolve, Math.min(20, remainingMs)))
        }
      }
      expect(requestId).toBeDefined()
      if (!requestId) throw new Error('Synthetic permission request missing from mailbox')
      expect(hasPermissionCallback(requestId)).toBe(true)
      fake.child.exitCode = 1
      fake.child.emit('exit', 1, null)
      expect(await running).toBeInstanceOf(Error)
      await flushCallbacks()
      expect(promptSettled).toBe(true)
      expect(appState.pendingWorkerRequest).toBeNull()
      expect(hasPermissionCallback(requestId)).toBe(false)
      expect(processMailboxPermissionResponse({ requestId, decision: 'approved' })).toBe(false)
      expect(parentController.signal.aborted).toBe(false)
      expect(fake.sent.filter(message => message.id === 'approval-test')).toEqual([])
    } finally {
      parentController.abort()
      if (requestId) unregisterPermissionCallback(requestId)
      setDynamicTeamContext(previousTeamContext)
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      if (previousUserType === undefined) delete process.env.USER_TYPE
      else process.env.USER_TYPE = previousUserType
      await rm(fixture, { recursive: true, force: true })
    }
  })

  for (const stop of ['cancel', 'completed turn', 'shutdown'] as const) {
    for (const outcome of ['allow', 'reject'] as const) {
      test(`ignores late ${outcome} after ${stop} without writing to closed stdin`, async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), 'repl-pending-approval-test-'))
        const fake = createApprovalServer(cwd, false)
        const controller = new AbortController()
        const decision = deferred<CodexAppServerApprovalDecision>()
        const opened = deferred<void>()
        try {
          const running = drain(runCodexNativeAppServer({
            prompt: 'Synthetic pending permission test',
            cwd,
            extraEnv: { CODEX_HOME: cwd },
            abortSignal: controller.signal,
            requestApproval: () => {
              opened.resolve()
              return decision.promise
            },
          }, fake.deps)).then(() => null, error => error as Error)
          await opened.promise
          if (stop === 'cancel') controller.abort(new Error('Synthetic cancellation'))
          if (stop === 'completed turn') fake.complete()
          if (stop === 'shutdown') {
            fake.child.exitCode = 1
            fake.child.emit('exit', 1, null)
          }
          const failure = await running
          if (stop === 'completed turn') {
            expect(failure).toBeNull()
          } else {
            expect(failure?.message).toContain(
              stop === 'cancel' ? 'Synthetic cancellation' : 'exited unexpectedly',
            )
          }
          expect(fake.stdin.writableEnded).toBe(true)
          if (outcome === 'allow') {
            decision.resolve({ allow: true })
          } else {
            decision.reject(new Error('Synthetic prompt dismissed'))
          }
          await flushCallbacks()
          expect(fake.sent.filter(message => message.id === 'approval-test')).toEqual([])
          expect(fake.writeErrors).toEqual([])
        } finally {
          await rm(cwd, { recursive: true, force: true })
        }
      })
    }
  }
})
