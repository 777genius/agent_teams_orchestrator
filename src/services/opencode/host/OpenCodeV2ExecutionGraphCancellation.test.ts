import { expect, test, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { types } from 'node:util'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import filesystem from 'node:fs/promises'
import { validateExecutionGraph, readExecutionGraphFailure } from './OpenCodeV2ExecutionBinding.js'





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


test('graph failure keeps exact original error and sorted row identity without raw path', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-graph-failure-')))
  const files = ['b.bin', 'a.bin'].map(name => ({ path: path.join(root, name), sha256: 'a'.repeat(64) }))
  const original = Object.assign(new Error('SECRET-original-path'), { code: 'EPERM', syscall: 'lstat' })
  const probe = spyOn(filesystem, 'realpath').mockRejectedValue(original)
  try {
    await expect(validateExecutionGraph('2.0.0', { files, sha256: executionHash([...files].sort((a,b)=>a.path < b.path ? -1 : 1)) })).rejects.toBe(original)
    const facts = readExecutionGraphFailure(original)
    expect(facts?.index).toBe(0)
    expect(facts?.total).toBe(2)
    expect(facts?.readPhase).toBe('realpath')
    expect(facts?.realpath).toBeUndefined()
    expect(facts?.pathSha256).toBe(createHash('sha256').update(files[1]!.path).digest('hex'))
    expect(JSON.stringify(facts)).not.toContain(root)
    expect(JSON.stringify(facts)).not.toContain('SECRET')
  } finally { probe.mockRestore(); await rm(root, { recursive: true, force: true }) }
})



test('malformed graph path preserves the original TypeError instead of diagnostic failure', async () => {
  const files = [{ path: 42, sha256: 'a'.repeat(64) }] as unknown as Parameters<typeof validateExecutionGraph>[1]['files']
  const original = new TypeError('TEST-original-path-type')
  const check = spyOn(path, 'isAbsolute').mockImplementation(() => { throw original })
  try {
    await expect(validateExecutionGraph('2.0.0', { files, sha256: executionHash(files) })).rejects.toBe(original)
    expect(readExecutionGraphFailure(original)).toBeUndefined()
  } finally { check.mockRestore() }
})
