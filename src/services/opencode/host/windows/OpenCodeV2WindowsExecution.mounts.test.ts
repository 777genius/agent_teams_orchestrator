import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { NonSharedBuffer } from 'node:buffer'
import type { PathLike, ObjectEncodingOptions, BufferEncodingOption } from 'node:fs'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import * as native from './OpenCodeV2WindowsNativeBroker.js'
import { closeWindowsExecutionPlan, planWindowsExecution } from './OpenCodeV2WindowsExecution.js'

// Isolated plan-boundary test only. Native HANDLE/ACL/containment qualification
// belongs to Windows CI; these spies cannot supply production launch authority.
test('Windows plan admits canonical identity mounts and retains genuine alias refusal', async () => {
  if (process.env.TEST_WINDOWS_IDENTITY_MOUNTS_ISOLATED !== '1') {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, TEST_WINDOWS_IDENTITY_MOUNTS_ISOLATED: '1' }, stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, output: code === 0 ? '' : stdout + stderr }).toEqual({ code: 0, output: '' })
    return
  }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
  const bytes = Buffer.from('TEST pinned executable bytes'), sha256 = createHash('sha256').update(bytes).digest('hex')
  const observed: string[] = []
  function physicalPath(value: PathLike, options?: ObjectEncodingOptions | BufferEncoding | null): Promise<string>
  function physicalPath(value: PathLike, options: BufferEncodingOption): Promise<NonSharedBuffer>
  function physicalPath(value: PathLike, options?: ObjectEncodingOptions | BufferEncodingOption | BufferEncoding | null): Promise<string | NonSharedBuffer>
  async function physicalPath(value: PathLike, options?: ObjectEncodingOptions | BufferEncodingOption | BufferEncoding | null): Promise<string | NonSharedBuffer> {
    const name = String(value); observed.push(name)
    const canonical = name === 'C:\\TEST\\noncanonical' ? 'C:\\TEST\\canonical' : name
    return options && typeof options === 'object' && options.encoding === 'buffer' ? Buffer.from(canonical) : canonical
  }
  const physical = spyOn(fs, 'realpath').mockImplementation(physicalPath)
  const read = spyOn(fs, 'readFile').mockResolvedValue(bytes)
  const absolute = spyOn(path, 'isAbsolute').mockImplementation(path.win32.isAbsolute)
  const parse = spyOn(path, 'parse').mockImplementation(path.win32.parse)
  const helper = spyOn(native, 'resolveWindowsNativeArtifact').mockResolvedValue({ path: 'C:\\TEST\\native\\helper.exe', sha256, arch: 'x64' })
  const dll = spyOn(native, 'resolveWindowsRealpathArtifact').mockResolvedValue({ path: 'C:\\TEST\\native\\realpath.dll', sha256, arch: 'x64' })
  let closed = 0
  const broker = spyOn(native, 'createWindowsNativeBroker').mockReturnValue({
    events: new EventEmitter(), request: async () => { throw new Error('TEST no native requests') },
    close: async () => { closed++ }, ended: () => false,
  })
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    Object.defineProperty(process, 'arch', { ...arch, value: 'x64' })
    const input = { bun: { path: 'C:\\TEST\\bun.exe', sha256 }, entry: 'C:\\TEST\\source\\entry.ts',
      cwd: 'C:\\TEST\\project', writableRoots: ['C:\\TEST\\profile'], readOnlyRoots: ['C:\\TEST\\source'],
      profileDirectories: ['C:\\TEST\\profile'], env: {},
      readOnlyMounts: [{ source: 'C:\\TEST\\dependencies', target: 'C:\\TEST\\dependencies' }] }
    const plan = await planWindowsExecution(input)
    try {
      expect(plan.readOnlyRoots).toEqual(['C:\\TEST\\source', 'C:\\TEST\\dependencies'])
      expect(observed).toContain('C:\\TEST\\dependencies')
      expect(input.readOnlyRoots).toEqual(['C:\\TEST\\source'])
      expect(Object.isFrozen(plan.readOnlyRoots)).toBe(true)
    } finally { await closeWindowsExecutionPlan(plan) }
    expect(closed).toBe(1)
    await expect(planWindowsExecution({ ...input, readOnlyMounts: [input.readOnlyMounts[0]!,
      { source: 'C:\\TEST\\actual', target: 'C:\\TEST\\alias' }] })).rejects.toThrow('execution_containment_path_alias_pending')
    await expect(planWindowsExecution({ ...input, readOnlyMounts: [
      { source: 'C:\\TEST\\noncanonical', target: 'C:\\TEST\\noncanonical' }] })).rejects.toThrow('execution_path_alias')
    expect(broker).toHaveBeenCalledTimes(1)
  } finally {
    physical.mockRestore(); read.mockRestore(); absolute.mockRestore(); parse.mockRestore()
    helper.mockRestore(); dll.mockRestore(); broker.mockRestore()
    Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch)
  }
})
