import { AsyncLocalStorage } from 'node:async_hooks'

import {
  OpenCodeLaunchAttemptBridge,
  type OpenCodeLaunchAttemptBridgePort,
} from './OpenCodeLaunchAttemptBridge.js'
import type { OpenCodeLaunchAttemptResult } from './OpenCodeLaunchAttempt.js'

type Command = Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0]
type Output = Awaited<ReturnType<OpenCodeLaunchAttemptBridgePort['execute']>>

export type OpenCodeLaunchAttemptProductionRuntime = {
  /** Read-only S1 authorization; must run before the durable ledger gate. */
  authorize(command: Command): Promise<Command>
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
): OpenCodeLaunchAttemptBridge {
  const context = new AsyncLocalStorage<ExecutionContext>()

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
      const authorized = await runtime.authorize(command)
      return context.run({ command: authorized }, () => super.execute(authorized))
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
