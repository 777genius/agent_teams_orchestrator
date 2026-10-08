import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from '../../Tool.js'
import type { Message, StreamEvent } from '../../types/message.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import type { CodexAppServerApprovalDecision } from './appServerApproval.js'
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
        child.emit('error', options.signal?.reason ?? new Error('Cancelled'))
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
  for (const allow of [true, false]) {
    test(`routes ${allow ? 'allow' : 'deny'} through the scoped prompt and actual executor`, async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'repl-approval-test-'))
      const fake = createApprovalServer(cwd)
      const observed: Array<{
        name: string
        context: ToolUseContext
        force: string | undefined
      }> = []
      const context = {} as ToolUseContext
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
        expect(observed).toEqual([{ name: 'Bash', context, force: 'ask' }])
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
