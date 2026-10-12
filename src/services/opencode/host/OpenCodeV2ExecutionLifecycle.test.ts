import { expect, test } from 'bun:test'
import { isExecutionCleanupReceipt, retireExecutionChild, type ExecutionRetirementPort } from './OpenCodeV2ExecutionLifecycle.js'

const birth = { format: 'darwin-pidversion' as const, value: '123:4', bootId: '11111111-1111-1111-1111-111111111111' }
function retirement(work: Promise<unknown>): ExecutionRetirementPort {
  return { pid: 73, birth, exited: () => true, acknowledged: () => true,
    disposeTransport: async () => undefined, sendClose: () => undefined,
    waitExit: Promise.resolve(), readBirth: async () => null, kill: () => undefined,
    retireOwnedDescendants: () => work }
}

// Previously the outer four-second timeout abandoned native reaping before its
// concrete twelve-second RPC finished. Waiting longer must not confer authority.
test.skipIf(process.platform !== 'darwin')('joins native retirement beyond four seconds while refusing an unowned receipt', async () => {
  const forged = { pid: 73, birth, scopeClosed: true, tasksStarted: '8', tasksExited: '8' }
  let settled = false
  const work = new Promise<unknown>(resolve => setTimeout(() => { settled = true; resolve(forged) }, 4200))
  await expect(retireExecutionChild(retirement(work))).rejects.toThrow('cleanup_unknown')
  expect(settled).toBe(true)
  expect(isExecutionCleanupReceipt(forged)).toBe(false)
}, 6000)

// A wider native budget remains finite. A hung adapter with successful caller
// close fields must still fail without producing a durable release receipt.
test('hung native retirement is bounded and remains unknown', async () => {
  await expect(retireExecutionChild(retirement(new Promise(() => undefined)))).rejects.toThrow('cleanup_unknown')
}, process.platform === 'darwin' ? 18_000 : 6000)
