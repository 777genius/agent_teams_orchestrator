import { expect, mock, test } from 'bun:test'
import type { ExecutionRetirementPort } from './OpenCodeV2ExecutionLifecycle.js'

// mock.module is process-wide in bun test, so the contract runs in its own bun test process
// and never leaks the stand-in adapter into other files of the same run.
const isolated = process.env.TEST_OPENCODE_LIFECYCLE_ISOLATED === '1'
if (!isolated) test('retirement receipt contract (isolated process)', async () => {
  const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
    env: { ...process.env, TEST_OPENCODE_LIFECYCLE_ISOLATED: '1' }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect({ exit, output: exit === 0 ? '' : stdout + stderr }).toEqual({ exit: 0, output: '' })
}, 30_000)

// The platform adapter brands its own retirement evidence; this TEST stands in for it with a
// short budget so a hung retirement is observed quickly.
const platform = await import('./OpenCodeV2ExecutionPlatform.js')
if (isolated) mock.module('./OpenCodeV2ExecutionPlatform.js', () => ({
  ...platform,
  executionPlatformRetirementBudgetMs: () => 300,
  requireExecutionPlatformRetirement: (value: unknown) => {
    const row = value as { scopeClosed?: unknown } | undefined
    if (!row || row.scopeClosed !== true) throw new Error('cleanup_unknown')
    return row
  },
}))
const { isExecutionCleanupReceipt, retireExecutionChild } = await import('./OpenCodeV2ExecutionLifecycle.js')
const contract = isolated ? test : test.skip

const birth = { format: 'utc-ms' as const, value: '1700000000000', bootId: null }
function retirement(work: Promise<unknown>): ExecutionRetirementPort {
  return { pid: 73, birth, exited: () => true, acknowledged: () => true,
    disposeTransport: async () => undefined, sendClose: () => undefined,
    waitExit: Promise.resolve(), readBirth: async () => null, kill: () => undefined,
    retireOwnedDescendants: () => work }
}

contract('a checked empty process group mints a receipt that claims retired descendants; best-effort does not', async () => {
  const group = await retireExecutionChild(retirement(Promise.resolve({ pid: 73, birth, scopeClosed: true, descendants: 'process-group' })))
  expect(isExecutionCleanupReceipt(group)).toBe(true)
  expect(group).toEqual({ scopeClosed: true, processRetired: true, descendantsRetired: true, pid: 73, birth })
  const tree = await retireExecutionChild(retirement(Promise.resolve({ pid: 73, birth, scopeClosed: true, descendants: 'best-effort' })))
  expect(isExecutionCleanupReceipt(tree)).toBe(true)
  expect(tree.descendantsRetired).toBe(false)
})

contract('retirement keeps the original identity failure while still attempting kernel cleanup', async () => {
  const failure = new Error('execution_identity_unknown'), calls: string[] = []
  const port = retirement(Promise.resolve(undefined))
  port.readBirth = async () => { calls.push('birth'); throw failure }
  port.retireOwnedDescendants = async () => { calls.push('kernel'); return undefined }
  const error = await retireExecutionChild(port).then(() => undefined, error => error)
  expect(error?.message).toBe('cleanup_unknown')
  expect(error?.cause).toBe(failure)
  expect(calls).toEqual(['birth', 'kernel'])
})

contract('hung retirement is bounded and remains unknown', async () => {
  await expect(retireExecutionChild(retirement(new Promise(() => undefined)))).rejects.toThrow('cleanup_unknown')
}, 6000)

contract('a retirement without the closed acknowledgement or with foreign evidence mints no receipt', async () => {
  const unacknowledged = retirement(Promise.resolve({ pid: 73, birth, scopeClosed: true, descendants: 'process-group' }))
  unacknowledged.acknowledged = () => false
  await expect(retireExecutionChild(unacknowledged)).rejects.toThrow('cleanup_unknown')
  await expect(retireExecutionChild(retirement(Promise.resolve({ pid: 74, birth, scopeClosed: true, descendants: 'process-group' }))))
    .rejects.toThrow('cleanup_unknown')
  await expect(retireExecutionChild(retirement(Promise.resolve({ pid: 73, birth, scopeClosed: false, descendants: 'unknown' }))))
    .rejects.toThrow('cleanup_unknown')
})
