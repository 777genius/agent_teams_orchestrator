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

test('native directory alias predicate source preserves short circuit and closed original reply', async () => {
  const { runInNewContext } = await import('node:vm')
  const { decodeWindowsNativeFailure, readWindowsNativeAliasFailure } = await import('../../src/services/opencode/host/windows/OpenCodeV2WindowsNativeBroker.js')
  const source = await readFile(path.resolve(import.meta.dir, '../../src/services/opencode/host/windows/WindowsKernelScope.cpp'), 'utf8')
  const start = source.indexOf('static Handle canonicalDirectory('), begin = source.indexOf('  FILE_ATTRIBUTE_TAG_INFO tag{};', start), end = source.indexOf('  if (qualifyAcl)', begin)
  const body = source.slice(begin, end).replace('FILE_ATTRIBUTE_TAG_INFO tag{};', 'const tag = { FileAttributes: attributes };').replaceAll('sizeof(tag)', '0').replaceAll('&tag', 'tag').replaceAll('__LINE__', '1')
  for (const query of [false, true]) for (const directory of [false, true]) for (const reparse of [false, true]) for (const canonical of [false, true]) {
    const checks: number[] = [], original = new Error('original-alias')
    const context = { attributes: (directory ? 16 : 0) | (reparse ? 1024 : 0), handle: { value: 1 }, full: 'expected',
      FILE_ATTRIBUTE_DIRECTORY: 16, FILE_ATTRIBUTE_REPARSE_POINT: 1024, FileAttributeTagInfo: 0,
      GetFileInformationByHandleEx: () => query, finalPath: () => 'observed', equalPath: () => canonical,
      requireAlias: (value: unknown, _code: string, _line: number, predicate: number) => { checks.push(predicate); if (!value) throw original } }
    let caught: unknown
    try { runInNewContext(body, context) } catch (error) { caught = error }
    expect(caught).toBe(query && directory && !reparse && canonical ? undefined : original)
    expect(checks).toEqual(!query ? [1] : !directory ? [1, 2] : reparse ? [1, 2, 3] : [1, 2, 3, 4])
  }
  expect(source).toContain('error.nativeStatus, error.aliasSourceLine, error.aliasPredicates}')
  expect(source).toContain('str(alias, L"operation", requestedOperation)')
  expect(source).toContain('num(alias, L"sourceLine", error.aliasSourceLine)')
  expect(source).toContain('num(alias, L"predicates", error.aliasPredicates)')
  const reply = { error: 'execution_path_alias', stage: 'alias_predicate', nativeCode: 0, alias: { operation: 'runStateSelect', sourceLine: 400, predicates: 2 } }
  const error = decodeWindowsNativeFailure(reply, 'runStateSelect')
  expect(readWindowsNativeAliasFailure(error)).toEqual({ operation: 'runStateSelect', sourceLine: 400, predicate: 2, passed: false })
  expect(readWindowsNativeAliasFailure(decodeWindowsNativeFailure(reply, 'ownerOpenDirectory'))).toBeUndefined()
  expect(readWindowsNativeAliasFailure(decodeWindowsNativeFailure({ ...reply, alias: { ...reply.alias, path: 'SECRET' } }, 'runStateSelect'))).toBeUndefined()
})
