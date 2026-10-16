import { expect, test, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import filesystem, { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { createExecutionGraphValidationCohort, type ExecutionGraph } from './OpenCodeV2ExecutionBinding.js'

// Real files and the real complete validator. The fixture graph has no official
// server module, so every complete pass ends in its closure check; the pass count
// is the number of graph-row realpath reads.
async function graphFixture(count = 40) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-graph-cohort-')))
  const content = Buffer.alloc(4096, 41)
  const sha256 = createHash('sha256').update(content).digest('hex')
  const rows = Array.from({ length: count }, (_, index) => ({ path: path.join(root, `${String(index).padStart(3, '0')}.bin`), sha256 }))
  await Promise.all(rows.map(row => writeFile(row.path, content)))
  const receipt = (files: ExecutionGraph['files']): ExecutionGraph =>
    ({ files, sha256: executionHash([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) })
  const paths = new Set(rows.map(row => row.path))
  let reads = 0, barrier: Promise<void> | undefined
  const original = filesystem.realpath
  const probe = spyOn(filesystem, 'realpath').mockImplementation((async (...args: Parameters<typeof original>) => {
    if (paths.has(String(args[0]))) { reads++; if (barrier) await barrier }
    return original(...args)
  }) as typeof original)
  return { rows, receipt, reads: () => reads, block: (value: Promise<void> | undefined) => { barrier = value },
    close: async () => { probe.mockRestore(); await rm(root, { recursive: true, force: true }) } }
}
const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setTimeout(resolve, 1)) }

test('cohort joins only concurrent byte-identical receipts and never reuses a settled result', async () => {
  const f = await graphFixture()
  try {
    const validate = createExecutionGraphValidationCohort()
    const exact = f.receipt(f.rows)
    const reordered: ExecutionGraph = { sha256: exact.sha256, files: [...f.rows].reverse() }
    // Same claimed digest with other rows must never join the exact receipt's pass.
    const forged: ExecutionGraph = { sha256: exact.sha256, files: f.rows.slice(1) }
    const changedRows = f.rows.map((row, index) => index === 7 ? { ...row, sha256: 'e'.repeat(64) } : row)
    const changed = f.receipt(changedRows)
    const results = await Promise.allSettled([validate('2.0.0', exact), validate('2.0.0', reordered),
      validate('2.0.0', structuredClone(exact)), validate('2.0.0', forged), validate('2.0.0', changed), validate('2.0.21', exact)])
    const reasons = results.map(result => result.status === 'rejected' ? result.reason : undefined)
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    // One complete pass for the three exact receipts, one for the changed rows and
    // one for the other pin; the forged receipt is refused before any read.
    expect(reasons[1]).toBe(reasons[0]); expect(reasons[2]).toBe(reasons[0])
    expect(reasons[3]).toMatchObject({ message: 'execution_graph_changed' })
    expect(reasons[4]).toMatchObject({ message: 'execution_graph_changed' })
    expect(reasons[4]).not.toBe(reasons[0]); expect(reasons[5]).not.toBe(reasons[0])
    expect(f.reads()).toBeGreaterThanOrEqual(f.rows.length * 2 + 8)
    expect(f.reads()).toBeLessThanOrEqual(f.rows.length * 3)
    const settledReads = f.reads()
    await expect(validate('2.0.0', exact)).rejects.not.toBe(reasons[0])
    expect(f.reads() - settledReads).toBe(f.rows.length)
  } finally { await f.close() }
})

test('cohort cancels shared reads only after every joined caller cancels and the last joins its drain', async () => {
  const f = await graphFixture()
  try {
    const validate = createExecutionGraphValidationCohort(), exact = f.receipt(f.rows)
    let release!: () => void
    f.block(new Promise<void>(resolve => { release = resolve }))
    const first = new AbortController(), second = new AbortController()
    const firstReason = new Error('TEST-first-cancelled'), secondReason = new Error('TEST-second-cancelled')
    const a = validate('2.0.0', exact, first.signal), b = validate('2.0.0', exact, second.signal)
    let bSettled = false
    void b.then(() => { bSettled = true }, () => { bSettled = true })
    await settle()
    const claimed = f.reads()
    expect(claimed).toBe(16)
    first.abort(firstReason)
    await expect(a).rejects.toBe(firstReason)
    second.abort(secondReason)
    await settle()
    // The last caller waits for the already claimed reads and no new row is claimed.
    expect(bSettled).toBe(false)
    release()
    await expect(b).rejects.toBe(secondReason)
    expect(f.reads()).toBe(claimed)
    f.block(undefined)
    // A cancelled shared pass is not joined by a later caller.
    const later = await validate('2.0.0', exact).then(() => null, error => error)
    expect(later).not.toBe(secondReason)
    expect(f.reads() - claimed).toBe(f.rows.length)

    // One cancelled caller does not cancel a peer that still needs the result.
    let unblock!: () => void
    f.block(new Promise<void>(resolve => { unblock = resolve }))
    const cancelled = new AbortController(), peerReason = new Error('TEST-peer-cancelled')
    const before = f.reads()
    const c = validate('2.0.0', exact, cancelled.signal), d = validate('2.0.0', exact, new AbortController().signal)
    await settle()
    cancelled.abort(peerReason)
    await expect(c).rejects.toBe(peerReason)
    unblock(); f.block(undefined)
    const peer = await d.then(() => null, error => error)
    expect(peer).not.toBe(peerReason)
    expect(f.reads() - before).toBe(f.rows.length)
  } finally { await f.close() }
})
