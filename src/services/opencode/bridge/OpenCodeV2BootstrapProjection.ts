import { executionAssert, executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionInstruction, ExecutionJson, ExecutionLog, ExecutionMessagePage } from '../transport/OpenCodeV2ExecutionClientFactory.js'

/** Both published instruction-entry.put APIs promise durable context announced
 * at the next step boundary. Readback verifies that context; synced bracketed
 * transcript/log cuts separately prove no model/assistant/tool bootstrap turn. */
export function verifyOpenCodeV2SilentBootstrap(input: {
  before: { messages: ExecutionMessagePage; log: ExecutionLog }
  after: { messages: ExecutionMessagePage; log: ExecutionLog }
  entries: readonly ExecutionInstruction[]; key: string; value: ExecutionJson
}): void {
  const matches = input.entries.filter(entry => entry.key === input.key)
  executionAssert(matches.length === 1 && executionHash(matches[0]?.value) === executionHash(input.value), 'run_bootstrap_unknown')
  for (const cut of [input.before, input.after]) executionAssert(cut.log.synced === true &&
    cut.messages.next === null && cut.messages.previous === null && cut.log.watermark === (cut.log.events.at(-1)?.seq ?? null), 'run_bootstrap_incomplete')
  executionAssert(executionHash(input.before.messages) === executionHash(input.after.messages), 'run_bootstrap_model_turn')
  const prefix = input.after.log.events.slice(0, input.before.log.events.length)
  executionAssert(executionHash(prefix) === executionHash(input.before.log.events), 'run_bootstrap_mutable_cut')
  const added = input.after.log.events.slice(input.before.log.events.length)
  executionAssert(added.every(event => event.type === 'session.instructions.updated'), 'run_bootstrap_model_turn')
}
