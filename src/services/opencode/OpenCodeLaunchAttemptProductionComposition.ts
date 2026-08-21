import { AsyncLocalStorage } from 'node:async_hooks'

import {
  OpenCodeLaunchAttemptBridge,
  type OpenCodeLaunchAttemptBridgePort,
} from './OpenCodeLaunchAttemptBridge.js'
import type { OpenCodeLaunchAttemptResult } from './OpenCodeLaunchAttempt.js'
import { canonicalizeOpenCodeProjectIdentity } from './OpenCodeProjectIdentity.js'
import { openCodeMonotonicNow } from './OpenCodeRuntimeDeadline.js'

type Command = Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0]
type Output = Awaited<ReturnType<OpenCodeLaunchAttemptBridgePort['execute']>>

export type OpenCodeLaunchAttemptProductionRuntime = {
  /** Read-only S1 authorization; must run before the durable ledger gate. */
  authorize(command: Command, controls: Readonly<{
    signal: AbortSignal
    deadlineAtMs: number
    remainingMs(): number
  }>): Promise<Command>
  /** Durable, read-only gate. Null is the only result that authorizes effects. */
  inspect(command: Command): Promise<Output | null>
  executeAfterPreflight(command: Command): Promise<{
    output: Output
    result: OpenCodeLaunchAttemptResult
  }>
}

type ExecutionContext = {
  command: Command
  execution?: Awaited<ReturnType<OpenCodeLaunchAttemptProductionRuntime['executeAfterPreflight']>>
}

/**
 * Installs the production runtime behind the accepted ledger-first Bridge.
 * AsyncLocalStorage keeps concurrent commands isolated without a mutable
 * command-to-result side channel.
 */
export function createOpenCodeLaunchAttemptProductionBridge(
  runtime: OpenCodeLaunchAttemptProductionRuntime,
  dependencies: Readonly<{
    monotonicNow?: () => number
    canonicalizeProject?: typeof canonicalizeOpenCodeProjectIdentity
    setTimer?: typeof setTimeout
    clearTimer?: typeof clearTimeout
  }> = {},
): OpenCodeLaunchAttemptBridge {
  const context = new AsyncLocalStorage<ExecutionContext>()
  const monotonicNow = dependencies.monotonicNow ?? openCodeMonotonicNow
  const canonicalizeProject = dependencies.canonicalizeProject ?? canonicalizeOpenCodeProjectIdentity

  class ProductionBridge extends OpenCodeLaunchAttemptBridge {
    constructor() {
      super({
        commandLedger: {
          read: async () => {
            const active = context.getStore()
            if (!active) throw new Error('OpenCode production launch command context is absent')
            const output = await runtime.inspect(active.command)
            if (!output) return { status: 'absent' }
            const status = readStatus(output) === 'reconciliation_required'
              ? 'unknown' as const
              : 'completed' as const
            return { status, snapshot: output.snapshot, data: output.data }
          },
        },
        attempt: {
          run: async () => {
            const active = context.getStore()
            if (!active) throw new Error('OpenCode production launch command context is absent')
            const deadlineAtMs = active.command.deadlineAtMs
            active.command.outerRemainingBudgetMs = deadlineAtMs === undefined
              ? active.command.outerRemainingBudgetMs
              : Math.max(0, deadlineAtMs - monotonicNow())
            active.execution = await runtime.executeAfterPreflight(active.command)
            return active.execution.result
          },
        },
        projection: {
          fromDurableResult: async () => {
            const output = context.getStore()?.execution?.output
            if (!output) throw new Error('OpenCode production durable projection is absent')
            return output
          },
        },
      })
    }

    override async execute(command: Command): ReturnType<OpenCodeLaunchAttemptBridgePort['execute']> {
      const budget = command.outerRemainingBudgetMs ?? command.requestedBudgetMs
      const now = monotonicNow()
      const legacyDeadlineAtMs = now + Math.max(0, budget)
      const deadlineAtMs = command.deadlineAtMs === undefined
        ? legacyDeadlineAtMs : Math.min(command.deadlineAtMs, legacyDeadlineAtMs)
      const controller = new AbortController()
      const abort = () => controller.abort(command.signal?.reason
        ?? new Error('OpenCode launch authorization cancelled'))
      if (command.signal?.aborted) abort()
      else command.signal?.addEventListener('abort', abort, { once: true })
      const timeout = (dependencies.setTimer ?? setTimeout)(() => controller.abort(
        new Error('OpenCode launch absolute deadline expired during authorization'),
      ), Math.max(0, deadlineAtMs - monotonicNow()))
      timeout.unref?.()
      const controls = Object.freeze({
        signal: controller.signal,
        deadlineAtMs,
        remainingMs: () => Math.max(0, deadlineAtMs - monotonicNow()),
      })
      const boundary = new Promise<never>((_, reject) => {
        const rejectAbort = () => reject(controller.signal.reason)
        if (controller.signal.aborted) rejectAbort()
        else controller.signal.addEventListener('abort', rejectAbort, { once: true })
      })
      try {
        const projectIdentity = await Promise.race([
          canonicalizeProject(command.projectPath, { signal: controller.signal }), boundary,
        ])
        const canonicalCommand = Object.freeze({ ...command, projectPath: projectIdentity,
          projectIdentity, deadlineAtMs, signal: controller.signal })
        const authorized = await Promise.race([
          runtime.authorize(canonicalCommand, controls), boundary,
        ])
        const remaining = controls.remainingMs()
        if (remaining <= 0) throw controller.signal.reason
          ?? new Error('OpenCode launch absolute deadline expired during authorization')
        if (authorized.projectPath !== projectIdentity
          || authorized.projectIdentity !== projectIdentity
          || authorized.deadlineAtMs !== deadlineAtMs
          || authorized.signal !== controller.signal) {
          throw new Error('OpenCode launch authorization changed frozen command identity')
        }
        const boundedCommand = Object.isExtensible(authorized)
          ? authorized : { ...authorized }
        boundedCommand.outerRemainingBudgetMs = remaining
        // Keep the production runtime's authorized object identity while
        // making the security-sensitive fields immutable end-to-end.
        Object.defineProperties(boundedCommand, {
          projectPath: { value: projectIdentity, enumerable: true, writable: false },
          projectIdentity: { value: projectIdentity, enumerable: true, writable: false },
          deadlineAtMs: { value: deadlineAtMs, enumerable: true, writable: false },
          signal: { value: controller.signal, enumerable: true, writable: false },
        })
        return await context.run({ command: boundedCommand }, () => super.execute(boundedCommand))
      } finally {
        ;(dependencies.clearTimer ?? clearTimeout)(timeout)
        command.signal?.removeEventListener('abort', abort)
      }
    }
  }

  return new ProductionBridge()
}

function readStatus(output: Output): string | undefined {
  if (!output.data || typeof output.data !== 'object') return undefined
  const attempt = (output.data as { launchAttempt?: unknown }).launchAttempt
  if (!attempt || typeof attempt !== 'object') return undefined
  return (attempt as { status?: unknown }).status as string | undefined
}
