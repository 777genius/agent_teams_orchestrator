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

test('native command liveness reuses one bounded complete proof only for stdio data', async () => {
  const { runInNewContext } = await import('node:vm')
  const windows = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows')
  // A Windows checkout may use CRLF; the extracted source text is compared as LF.
  const source = async (name: string) => (await readFile(path.join(windows, name), 'utf8')).replaceAll('\r\n', '\n')
  const header = await source('WindowsNativeCommandLiveness.hpp')
  const scope = await source('WindowsKernelScope.cpp')
  const execution = await source('OpenCodeV2WindowsExecution.ts')
  const slice = (source: string, from: string, to: string) => {
    const begin = source.indexOf(from), end = source.indexOf(to, begin)
    expect(begin).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(begin)
    return source.slice(begin + from.length, end)
  }
  const kinds = (body: string) => body.replaceAll('L"', '"')
    .replaceAll('CommandLivenessKind::data', "'data'").replaceAll('CommandLivenessKind::complete', "'complete'")
  const classify = slice(header, 'static CommandLivenessKind commandLivenessKind(const std::wstring &operation) {', '\n}\n')
  const kind = (operation: string) => runInNewContext(`(function () {${kinds(classify)}})()`, {
    operation, require: (value: unknown, code: string) => { if (!value) throw new Error(code) } })
  for (const operation of ['commandRead', 'commandWriteStdin', 'commandEndStdin', 'commandStatus']) expect(kind(operation)).toBe('data')
  for (const operation of ['commandStart', 'commandRetire', 'commandClose']) expect(kind(operation)).toBe('complete')
  for (const operation of ['assertLive', 'commandread', '']) expect(() => kind(operation)).toThrow('execution_invalid_response')

  const reuseMs = Number(/static constexpr std::uint64_t reuseMs = (\d+);/.exec(header)?.[1])
  expect(reuseMs).toBe(5000)
  const admit = kinds(slice(header, 'void admit(CommandLivenessKind kind, Now now, Cheap cheap, Complete complete) {', '\n  }\n'))
    .replace('const std::uint64_t at', 'const at')
  const gate = { proven: false, provenAt: 0 }
  let clock = 1_000, cheapLive = true, completeFails = false, completes = 0, cheaps = 0
  const run = (operation: 'data' | 'complete') => {
    const context = { ...gate, kind: operation, reuseMs, now: () => clock, cheap: () => { cheaps++; return cheapLive },
      complete: () => { completes++; clock += 1_300; if (completeFails) throw new Error('anchor_changed') } }
    try { runInNewContext(`(function () {${admit}})()`, context) }
    finally { gate.proven = context.proven; gate.provenAt = context.provenAt }
  }
  const expectComplete = (operation: 'data' | 'complete', reconciled: boolean) => {
    const before = completes; run(operation); expect(completes - before).toBe(reconciled ? 1 : 0)
  }
  expectComplete('data', true) // No proof yet: the first data operation reconciles completely.
  expect(gate).toEqual({ proven: true, provenAt: 2_300 })
  clock += 4_999; expectComplete('data', false) // Inside the interval, after cheap checks.
  expect(cheaps).toBe(1)
  clock += 1; expectComplete('data', true) // Interval elapsed exactly: complete again.
  expectComplete('complete', true) // Start/retire/close never reuse a proof.
  cheapLive = false; expectComplete('data', true) // Cheap refusal falls through to complete.
  cheapLive = true
  completeFails = true; expect(() => run('complete')).toThrow('anchor_changed')
  expect(gate.proven).toBe(false)
  completeFails = false; expectComplete('data', true) // A failed proof is never reused, even in time.
  clock = gate.provenAt - 1; expectComplete('data', true) // Monotonic step back never extends it.

  // Lifecycle callers (empty input) pass the same gate, so their failure also
  // discards the proof; no other post-launch path reconciles outside it.
  const branch = slice(scope, '} else if (operation == L"assertLive") {', '} else if (operation == L"retire") {')
  expect(branch).toContain(['command ? commandLivenessKind(text(input, L"commandOperation"))',
    '                      : CommandLivenessKind::complete,'].join('\n'))
  expect(branch).toContain(['[&] { return scope->liveWithoutReconciliation(); },',
    '              [&] { scope->assertLiveComplete(); });', '          if (!command) {', '            value = scope->mapping;'].join('\n'))
  expect(scope.split('assertLiveComplete()').length - 1).toBe(2) // Definition and the gate only.
  expect(scope.split('assertRealpathAnchorsLive()').length - 1).toBe(3) // Definition, complete, pre-publication launch.
  expect(scope).toContain('require(!stopping && !exited() && active() > 0, "execution_identity_mismatch");\n    assertRealpathAnchorsLive();')
  expect(scope).toContain('try { return !stopping && !exited() && active() > 0; } catch (...) { return false; }')
  expect(execution).toContain('await options.assertLive(lifecycle.has(operation), operation)')
  expect(execution).toContain("=== 'anchorsReceiptId,nonce' && live.nonce === nonce &&\n      live.anchorsReceiptId === current.realpathAnchors.receiptId, 'execution_identity_mismatch')")
})
