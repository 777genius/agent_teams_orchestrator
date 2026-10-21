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

test('machine realpath anchor chains open their final object leaf-first', async () => {
  const { runInNewContext } = await import('node:vm')
  const realpath = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows/WindowsNativeRealpath.hpp')
  const source = (await readFile(realpath, 'utf8')).replaceAll('\r\n', '\n')
  const body = (from: string) => {
    const begin = source.indexOf(from)
    expect(begin).toBeGreaterThanOrEqual(0)
    const end = source.indexOf('\n}\n', begin)
    expect(end).toBeGreaterThan(begin)
    return source.slice(begin + from.length, end)
  }
  const js = (text: string) => text
    .replaceAll('wchar_t system[32768];', 'const system = [];')
    .replaceAll('std::wstring_view(system, size)', "system.join('')")
    .replaceAll('const std::wstring_view component =', 'const component =')
    .replaceAll('const std::vector<std::wstring> ', 'const ')
    .replaceAll('const std::wstring ', 'const ')
    .replaceAll('const size_t ', 'const ')
    .replaceAll('const DWORD ', 'const ')
    .replaceAll('const UINT ', 'const ')
    .replaceAll('const bool ', 'const ')
    .replaceAll('const full(path);', 'const full = path;')
    .replaceAll('HANDLE raw =', 'const raw =')
    .replaceAll('std::wstring_view()', "''")
    .replaceAll('.c_str()', '')
    .replaceAll('nullptr', 'null')
    .replaceAll("L'\\\\'", "'\\\\'")
    .replaceAll('L"', '"')
    .replaceAll('.substr(', '.substring(')
    .replaceAll('.size()', '.length')
  const lastNtComponent = (text: string) => text.substring(text.lastIndexOf('\\') + 1)
  const openedPath = () => {
    const handles = [] as unknown[] & { back?: () => unknown }
    handles.back = () => handles[handles.length - 1]
    return { handles, identities: [] as unknown[] }
  }

  // The admission branch itself: machine chains skip the held component walk
  // and open their final object in one parse, while caller roots walk as before.
  const checked = js(body(['inline bool openCheckedPath(std::wstring_view path, bool finalDirectory, DWORD finalShare,',
    '                            Operation openStage, Operation componentStage,',
    '                            OpenedPath& opened, Failure& failureOut) {'].join('\n')))
  const calls = { create: [] as unknown[][], relative: 0, admits: [] as unknown[][], failure: undefined as unknown }
  const context = {
    validateCanonicalInput: () => true, driveRoot: (value: string) => value.substring(0, 3),
    GetDriveTypeW: () => 3, DRIVE_FIXED: 3, machineChainPath: (full: string) =>
      full.toLowerCase().startsWith('c:\\windows\\system32'),
    splitDos: (value: string) => value.length <= 3 ? [] : value.substring(3).split('\\'), kMaxHeldHandles: 16384,
    FILE_SHARE_READ: 1, FILE_SHARE_WRITE: 2, FILE_READ_ATTRIBUTES: 0x80, SYNCHRONIZE: 0x100000,
    OPEN_EXISTING: 3, FILE_FLAG_BACKUP_SEMANTICS: 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT: 0x00200000,
    INVALID_HANDLE_VALUE: -1, GetLastError: () => 5,
    CreateFileW: (target: string, access: number, share: number) => {
      calls.create.push([target, access, share]); return 7 },
    Handle: (raw: number) => ({ raw, get: () => raw }), lastNtComponent,
    admitOpenedObject: (handle: unknown, directory: boolean, expected: string,
      _objectStage: unknown, _componentStage: unknown, opened: { handles: unknown[]; identities: unknown[] }) => {
      calls.admits.push([expected, directory]); opened.handles.push(handle); opened.identities.push({}); return true },
    openHeldRelativeChain: () => { calls.relative++; return true },
    failure: (status: string, operation: string, win32: number) =>
      (calls.failure = { status, operation, win32 }), REJECTED: 'rejected',
    invalid: (operation: string) => (calls.failure = { status: 'invalid', operation }),
    denied: (operation: string) => (calls.failure = { status: 'rejected', operation, win32: 5 }),
    machine: openedPath(), plain: openedPath(), deniedOpen: openedPath(),
    machineOpened: true,
  }
  const openCheckedPath = runInNewContext(
    `(function () {function openCheckedPath(path, finalDirectory, finalShare, openStage, componentStage, opened, failureOut) {${checked}\n};return openCheckedPath;})()`,
    context) as (...args: unknown[]) => boolean

  expect(openCheckedPath('C:\\Windows\\System32', true, 3, 'openAnchor', 'anchorComponent',
    context.machine, undefined)).toBe(true)
  expect(calls.create).toEqual([['\\\\?\\C:\\Windows\\System32', 0x80 | 0x100000, 3]])
  expect(calls.relative).toBe(0) // No drive root and no intermediate component is ever opened.
  expect(calls.admits).toEqual([['System32', true]])

  calls.create.length = 0; calls.admits.length = 0
  expect(openCheckedPath('D:\\a\\_temp\\profile', true, 3, 'openAnchor', 'anchorComponent',
    context.plain, undefined)).toBe(true)
  expect(calls.create).toEqual([['\\\\?\\D:\\', 0x80, 3]])
  expect(calls.relative).toBe(1) // Caller roots keep the held component chain.
  expect(calls.admits).toEqual([['', true]]) // The chain walk admits its drive root without a name.

  // A refused machine leaf keeps the anchor-scoped closed operation of the object.
  context.CreateFileW = () => -1
  expect(openCheckedPath('C:\\Windows\\System32', true, 3, 'openAnchor', 'anchorComponent',
    context.deniedOpen, undefined)).toBe(false)
  expect(calls.failure).toEqual({ status: 'rejected', operation: 'openAnchor', win32: 5 })
})

test('machine chain predicate keys on the system directory with a closed boundary', async () => {
  const { runInNewContext } = await import('node:vm')
  const realpath = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows/WindowsNativeRealpath.hpp')
  const source = (await readFile(realpath, 'utf8')).replaceAll('\r\n', '\n')
  const body = (from: string) => {
    const begin = source.indexOf(from)
    expect(begin).toBeGreaterThanOrEqual(0)
    const end = source.indexOf('\n}\n', begin)
    expect(end).toBeGreaterThan(begin)
    return source.slice(begin + from.length, end)
  }
  const js = (text: string) => text
    .replaceAll('wchar_t system[32768];', 'const system = [];')
    .replaceAll('std::wstring_view(system, size)', "system.join('')")
    .replaceAll('const UINT size', 'const size')
    .replaceAll("L'\\\\'", "'\\\\'")
    .replaceAll('L"', '"')
    .replaceAll('.substr(', '.substring(')
    .replaceAll('.size()', '.length')
  let systemDirectory: string | undefined = 'C:\\Windows\\System32'
  const context = {
    GetSystemDirectoryW: (buffer: string[]) => {
      if (systemDirectory === undefined) return 0
      buffer.push(...systemDirectory); return buffer.length },
    compareOrdinal: (left: string, right: string, ignoreCase: boolean) => {
      const compared = ignoreCase ? left.toLowerCase().localeCompare(right.toLowerCase()) : left.localeCompare(right)
      return compared === 0 ? 2 : compared < 0 ? 1 : 3 },
    CSTR_EQUAL: 2,
  }
  const predicate = runInNewContext(
    `(function () {function ntPrefixContains(value, prefix) {${js(body('inline bool ntPrefixContains(std::wstring_view value, std::wstring_view prefix) noexcept {'))}\n}\n` +
    `function machineChainPath(full) {${js(body('inline bool machineChainPath(std::wstring_view full) {'))}\n};return machineChainPath;})()`,
    context) as (full: string) => boolean
  expect(predicate('C:\\Windows\\System32')).toBe(true)
  expect(predicate('C:\\Windows\\System32\\cmd.exe')).toBe(true)
  expect(predicate('c:\\windows\\system32\\CMD.EXE')).toBe(true)
  expect(predicate('C:\\Windows\\System32x')).toBe(false) // Suffix names are never the machine chain.
  expect(predicate('C:\\Windows')).toBe(false)
  expect(predicate('D:\\a\\_temp\\profile')).toBe(false)
  systemDirectory = undefined
  expect(predicate('C:\\Windows\\System32')).toBe(false) // Unknown system directory falls back to the held chain.
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
    .replaceAll('CommandLivenessKind::teardown', "'teardown'")
  const require = (value: unknown, code: string) => { if (!value) throw new Error(code) }
  const classify = slice(header, 'static CommandLivenessKind commandLivenessKind(const std::wstring &operation) {', '\n}\n')
  const kind = (operation: string) => runInNewContext(`(function () {${kinds(classify)}})()`, { operation, require })
  for (const operation of ['commandRead', 'commandWriteStdin', 'commandEndStdin', 'commandStatus']) expect(kind(operation)).toBe('data')
  expect(kind('commandStart')).toBe('complete')
  for (const operation of ['commandRetire', 'commandClose']) expect(kind(operation)).toBe('teardown')
  for (const operation of ['assertLive', 'commandread', 'commandretire', '']) expect(() => kind(operation)).toThrow('execution_invalid_response')

  const reuseMs = Number(/static constexpr std::uint64_t reuseMs = (\d+);/.exec(header)?.[1])
  expect(reuseMs).toBe(5000)
  const admit = kinds(slice(header, 'void admit(CommandLivenessKind kind, Now now, Cheap cheap, Complete complete) {', '\n  }\n'))
    .replace('const std::uint64_t at', 'const at').replace('const bool live', 'const live')
  const gate = { proven: false, provenAt: 0 }
  let clock = 1_000, cheapLive = true, completeFails = false, completes = 0, cheaps = 0
  const run = (operation: 'data' | 'complete' | 'teardown') => {
    const context = { ...gate, kind: operation, reuseMs, require, now: () => clock, cheap: () => { cheaps++; return cheapLive },
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
  expectComplete('complete', true) // Start never reuses a proof.
  cheapLive = false; expectComplete('data', true) // Cheap refusal falls through to complete.
  cheapLive = true
  completeFails = true; expect(() => run('complete')).toThrow('anchor_changed')
  expect(gate.proven).toBe(false)
  completeFails = false; expectComplete('data', true) // A failed proof is never reused, even in time.
  clock = gate.provenAt - 1; expectComplete('data', true) // Monotonic step back never extends it.
  // Retire/close never reconcile and neither create nor extend a proof, even
  // after it expired; a refused constant-time check fails closed and discards it.
  const proof = { ...gate }, reconciled = completes, checked = cheaps
  run('teardown'); expect(gate).toEqual(proof)
  clock += 10_000; run('teardown'); expect(gate).toEqual(proof)
  expect(completes).toBe(reconciled); expect(cheaps).toBe(checked + 2)
  cheapLive = false; expect(() => run('teardown')).toThrow('execution_identity_mismatch')
  expect(gate.proven).toBe(false); expect(completes).toBe(reconciled)
  cheapLive = true; run('teardown'); expect(gate.proven).toBe(false)
  expectComplete('data', true) // Teardown left no proof for data to reuse.

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

test('run control connect keeps its deadline while the endpoint is transiently absent', async () => {
  const { runInNewContext } = await import('node:vm')
  const header = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows/WindowsNativeRunControl.hpp')
  const source = (await readFile(header, 'utf8')).replaceAll('\r\n', '\n')
  const begin = source.indexOf('    Handle pipe;\n    for (;;) {')
  expect(begin).toBeGreaterThanOrEqual(0)
  const loopStart = source.indexOf('for (;;) {', begin)
  const end = source.indexOf('\n    }\n', loopStart)
  expect(end).toBeGreaterThan(loopStart)
  const body = source.slice(loopStart, end + '\n    }'.length)
    .replaceAll('const HANDLE raw =', 'const raw =')
    .replaceAll('const DWORD error =', 'const error =')
    .replaceAll('const DWORD remaining =', 'const remaining =')
    .replaceAll('const DWORD waitError =', 'const waitError =')
    .replaceAll('throw NativeError{', 'throw nativeError(')
    .replaceAll('"connect"};', '"connect");')
    .replaceAll('.c_str()', '')
    .replaceAll('nullptr', 'null')
    .replaceAll('L"', '"')
  const ERROR_FILE_NOT_FOUND = 2, ERROR_ACCESS_DENIED = 5, ERROR_SEM_TIMEOUT = 121, ERROR_PIPE_BUSY = 231
  const plan = {
    open: [] as number[], // 0 opens the endpoint; any other value fails with that GetLastError
    wait: [] as Array<[number, number, number]>, // WaitNamedPipeW return, GetLastError, clock advance
  }
  const state = { now: 1000, lastError: 0, opens: [] as number[], waits: [] as number[], slept: [] as number[] }
  let openAt = 0, waitAt = 0
  const context = {
    require: (value: unknown, code: string) => { if (!value) throw new Error(code) },
    nativeError: (code: string, win32: number) => Object.assign(new Error(code), { code, win32 }),
    runControlRemaining: (deadline: number) => Math.max(0, deadline - state.now),
    Handle: (raw: number) => (raw < 0 ? null : { raw }),
    CreateFileW: () => {
      const outcome = plan.open[Math.min(openAt++, plan.open.length - 1)] ?? 0
      state.opens.push(outcome); state.lastError = outcome
      return outcome === 0 ? 7 : -1
    },
    WaitNamedPipeW: (_endpoint: string, timeout: number) => {
      const entry = plan.wait[Math.min(waitAt++, plan.wait.length - 1)] ?? [1, 0, 0]
      state.waits.push(timeout); state.now += entry[2]; state.lastError = entry[1]
      return entry[0]
    },
    GetLastError: () => state.lastError,
    Sleep: (ms: number) => { state.slept.push(ms); state.now += ms },
    GENERIC_READ: 1, GENERIC_WRITE: 2, OPEN_EXISTING: 3, FILE_FLAG_OVERLAPPED: 0x40000000,
    INVALID_HANDLE_VALUE: -1, ERROR_SUCCESS: 0,
    ERROR_FILE_NOT_FOUND, ERROR_ACCESS_DENIED, ERROR_SEM_TIMEOUT, ERROR_PIPE_BUSY,
  }
  const connect = runInNewContext(
    `(function () {return function (endpoint, deadline) {let pipe;\n${body}\nreturn pipe;};})()`,
    context) as (endpoint: string, deadline: number) => unknown
  const endpoint = '\\\\.\\pipe\\agt-v2-run-control-test'
  const reset = () => {
    state.now = 1000; state.lastError = 0; state.opens = []; state.waits = []; state.slept = []
    openAt = 0; waitAt = 0
  }

  // A saturated endpoint is a wait, not a refusal: the retry survives both a
  // WaitNamedPipeW timeout report and a lost open race until the instance wins.
  reset()
  plan.open = [ERROR_PIPE_BUSY, ERROR_PIPE_BUSY, 0]
  plan.wait = [[0, ERROR_SEM_TIMEOUT, 50], [1, 0, 0]]
  expect((connect(endpoint, 3000) as { raw: number }).raw).toBe(7)
  expect(state.opens).toEqual([ERROR_PIPE_BUSY, ERROR_PIPE_BUSY, 0])
  expect(state.waits.length).toBe(2)

  // A momentarily missing endpoint is absence, never run_control_connect_unknown.
  reset()
  plan.open = [ERROR_FILE_NOT_FOUND, 0]
  plan.wait = [[0, ERROR_FILE_NOT_FOUND, 0]]
  expect((connect(endpoint, 3000) as { raw: number }).raw).toBe(7)
  expect(state.opens).toEqual([ERROR_FILE_NOT_FOUND, 0])
  expect(state.slept).toEqual([10])

  // An exhausted budget reports the deadline token, never connect unknown.
  reset()
  plan.open = [ERROR_PIPE_BUSY]
  plan.wait = [[0, ERROR_SEM_TIMEOUT, 2000]]
  let caught: unknown
  try { connect(endpoint, 3000) } catch (error) { caught = error }
  expect((caught as Error).message).toBe('run_deadline_expired')

  // A true refusal still publishes the closed connect code with its native errno.
  reset()
  plan.open = [ERROR_ACCESS_DENIED]
  plan.wait = [[1, 0, 0]]
  try { connect(endpoint, 3000) } catch (error) { caught = error }
  expect((caught as { code: string }).code).toBe('run_control_connect_unknown')
  expect((caught as { win32: number }).win32).toBe(ERROR_ACCESS_DENIED)
  expect(state.waits).toEqual([])
})

test('run control listener always offers a fresh instance and survives connection refusals', async () => {
  const { runInNewContext } = await import('node:vm')
  const header = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows/WindowsNativeRunControl.hpp')
  const source = (await readFile(header, 'utf8')).replaceAll('\r\n', '\n')

  // The consumed instance is replaced before any fallible connection work.
  const acceptBody = source.slice(source.indexOf('JsonObject accept('), source.indexOf('JsonObject read('))
  const offer = acceptBody.indexOf('runControlOfferPending();')
  expect(offer).toBeGreaterThan(0)
  expect(offer).toBeLessThan(acceptBody.indexOf('runControlAuthenticate(*connection)'))
  expect(offer).toBeLessThan(acceptBody.indexOf('registry_.emplace'))
  // One spare instance over the live connection ceiling keeps replenish able to
  // create while every accepted connection still owns its own instance.
  expect(source).toContain('static_cast<DWORD>(MAX_CONNECTIONS + 2)')

  // A transient create refusal is retried; a genuine refusal neither poisons
  // the listener nor replaces its pending instance.
  const begin = source.indexOf('void runControlOfferPending() {')
  expect(begin).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n  }\n', begin)
  expect(end).toBeGreaterThan(begin)
  const body = source.slice(begin + 'void runControlOfferPending() {'.length, end)
    .replaceAll('for (DWORD attempt = 0;; ++attempt)', 'for (let attempt = 0;; ++attempt)')
    .replaceAll('catch (const NativeError &failure)', 'catch (failure)')
    .replaceAll('listener_->', 'listener.')
  const observed = { created: 0, slept: [] as number[] }
  const offerPending = (listener: { name: string; pending: unknown; poisoned: boolean },
    outcomes: Array<{ win32: number } | null>) => {
    observed.created = 0; observed.slept = []
    const context = {
      ERROR_PIPE_BUSY: 231,
      Sleep: (ms: number) => { observed.slept.push(ms) },
      runControlCreateServer: () => {
        const outcome = outcomes[Math.min(observed.created++, outcomes.length - 1)]
        if (outcome) throw Object.assign(new Error('run_control_listen_unknown'),
          { code: 'run_control_listen_unknown', win32: outcome.win32 })
        return { fresh: true }
      },
    }
    return runInNewContext(`(function () {return function (listener) {${body}\n};})()`,
      context) as (listener: unknown) => void
  }
  const listener = { name: '\\\\.\\pipe\\agt-v2-run-control-test', pending: { stale: true }, poisoned: false }
  offerPending(listener, [{ win32: 231 }, { win32: 231 }, null])(listener)
  expect(observed.created).toBe(3)
  expect(observed.slept).toEqual([10, 10])
  expect(listener.pending).toEqual({ fresh: true })
  expect(listener.poisoned).toBe(false)
  const refused = { name: listener.name, pending: { stale: true }, poisoned: false }
  expect(() => offerPending(refused, [{ win32: 5 }])(refused)).toThrow('run_control_listen_unknown')
  expect(observed.created).toBe(1)
  expect(refused.pending).toEqual({ stale: true })
  expect(refused.poisoned).toBe(false)

  // A connection-scoped refusal retires only its connection; the pump keeps
  // offering accepts while listener-scoped refusals remain terminal.
  const catchStart = source.lastIndexOf('} catch (const NativeError &failure) {')
  expect(catchStart).toBeGreaterThanOrEqual(0)
  const catchEnd = source.indexOf('\n      } catch (...) {', catchStart)
  expect(catchEnd).toBeGreaterThan(catchStart)
  const pumpBody = source.slice(catchStart + '} catch (const NativeError &failure) {'.length, catchEnd)
    .replaceAll('std::strcmp(', 'strcmp(')
    .replaceAll('failure.code.c_str()', 'failure.code')
    .replaceAll('JsonObject poison;', '')
    .replaceAll('num(poison, L"id", activeId);', '')
    .replaceAll('poisonConnection(poison)', 'poisonConnection(activeId)')
    .replaceAll('catch (...) {}', 'catch (ignored) {}')
    .replaceAll('break;', 'return "fatal";')
    .replaceAll('continue;', 'return "continued";')
  const reports: string[] = [], poisons: number[] = []
  const pumpStep = runInNewContext(
    `(function () {return function (failure, phase, activeId, requestPumpStop_, shutdown_) {
      try { throw failure } catch (failure) {${pumpBody}\n}
      return 'continued'
    };})()`,
    {
      strcmp: (a: string, b: string) => (a === b ? 0 : 1),
      reportFailure: (code: string) => { reports.push(code) },
      poisonConnection: (id: number) => { poisons.push(id) },
    }) as (failure: { code: string; win32: number }, phase: string, activeId: number,
      stop: boolean, down: boolean) => string
  expect(pumpStep({ code: 'run_control_disconnected', win32: 109 }, 'read_frame', 7, false, false)).toBe('continued')
  expect(pumpStep({ code: 'run_control_peer_identity', win32: 0 }, 'accept_authenticate', 7, false, false)).toBe('continued')
  expect(pumpStep({ code: 'run_control_accept_timeout', win32: 121 }, 'accept_wait', 0, false, false)).toBe('continued')
  expect(pumpStep({ code: 'run_control_accept_unknown', win32: 231 }, 'accept_wait', 0, false, false)).toBe('fatal')
  expect(pumpStep({ code: 'run_control_listen_unknown', win32: 231 }, 'accept_replenish', 7, false, false)).toBe('fatal')
  expect(pumpStep({ code: 'run_control_disconnected', win32: 109 }, 'read_frame', 7, true, false)).toBe('fatal')
  expect(poisons).toEqual([7, 7, 7, 7])
  expect(reports).toEqual(['run_control_disconnected', 'run_control_peer_identity',
    'run_control_accept_unknown', 'run_control_listen_unknown', 'run_control_disconnected'])
})
