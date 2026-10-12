import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stageWindowsHelper } from './stage-windows.js'

test('Windows packaging requires both exact producer identities and preserves delivered bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-stage-'))
  const producer = path.join(root, 'producer'), directory = path.join(producer, 'win32-x64')
  const delivery = path.join(root, 'delivery')
  await mkdir(directory, { recursive: true })
  const publish = async (name: string, manifest: string, dll: boolean, machine = 0x8664) => {
    const bytes = Buffer.alloc(128)
    bytes.write('MZ'); bytes.writeUInt32LE(64, 0x3c); bytes.write('PE\0\0', 64)
    bytes.writeUInt16LE(machine, 68); bytes.writeUInt16LE(dll ? 0x2000 : 0, 86)
    await writeFile(path.join(directory, name), bytes)
    await writeFile(path.join(directory, manifest), JSON.stringify({ format: 1, platform: 'win32', arch: 'x64', name,
      sha256: createHash('sha256').update(bytes).digest('hex') }))
    return bytes
  }
  try {
    const helper = await publish('opencode-v2-windows-helper.exe', 'windows-helper.json', false)
    await expect(stageWindowsHelper(producer, delivery, 'x64')).rejects.toThrow()
    await publish('opencode-v2-windows-realpath.dll', 'windows-realpath.json', true, 0xaa64)
    await expect(stageWindowsHelper(producer, delivery, 'x64')).rejects.toThrow('architecture or kind')
    await publish('opencode-v2-windows-realpath.dll', 'windows-realpath.json', false)
    await expect(stageWindowsHelper(producer, delivery, 'x64')).rejects.toThrow('architecture or kind')
    const dll = await publish('opencode-v2-windows-realpath.dll', 'windows-realpath.json', true)
    await writeFile(path.join(directory, 'opencode-v2-windows-realpath.dll'), Buffer.concat([dll, Buffer.from('changed')]))
    await expect(stageWindowsHelper(producer, delivery, 'x64')).rejects.toThrow('producer manifest')
    await writeFile(path.join(directory, 'opencode-v2-windows-realpath.dll'), dll)
    await stageWindowsHelper(producer, delivery, 'x64')
    const target = path.join(delivery, 'native', 'win32-x64')
    expect(await readFile(path.join(target, 'opencode-v2-windows-helper.exe'))).toEqual(helper)
    expect(await readFile(path.join(target, 'opencode-v2-windows-realpath.dll'))).toEqual(dll)
    expect(JSON.parse(await readFile(path.join(target, 'windows-realpath.json'), 'utf8')).sha256)
      .toBe(createHash('sha256').update(dll).digest('hex'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
