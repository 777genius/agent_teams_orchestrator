import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { validateExecutionGraph } from './OpenCodeV2ExecutionBinding.js'

test('graph cancellation drains claimed hashes and rejects before runtime closure traversal', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-graph-cancel-')))
  const controller = new AbortController(), reason = new Error('TEST-graph-cancelled')
  const content = Buffer.alloc(129 * 1024, 37)
  const sha256 = createHash('sha256').update(content).digest('hex')
  const files = Array.from({ length: 48 }, (_, index) => ({ path: path.join(root, `${String(index).padStart(2, '0')}.bin`), sha256 }))
  try {
    await Promise.all(files.map(file => writeFile(file.path, content)))
    const phases: string[] = []
    await expect(validateExecutionGraph('2.0.0', { files, sha256: executionHash(files) }, value => {
      phases.push(value.phase)
      if (value.completed >= 16) controller.abort(reason)
    }, controller.signal)).rejects.toBe(reason)
    expect(phases).toContain('hash')
    expect(phases).not.toContain('closure')
  } finally { await rm(root, { recursive: true, force: true }) }
})
