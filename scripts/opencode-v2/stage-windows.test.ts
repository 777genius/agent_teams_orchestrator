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
  const begin = source.indexOf('    Handle pipe;\n    for (')
  expect(begin).toBeGreaterThanOrEqual(0)
  const loopStart = source.indexOf('for (', begin)
  const end = source.indexOf('\n    }\n', loopStart)
  expect(end).toBeGreaterThan(loopStart)
  const body = source.slice(loopStart, end + '\n    }'.length)
    .replaceAll('for (DWORD connectError = ERROR_SUCCESS;;)', 'for (let connectError = ERROR_SUCCESS;;)')
    .replaceAll('const HANDLE raw =', 'const raw =')
    .replaceAll('const DWORD error =', 'const error =')
    .replaceAll('const DWORD remaining =', 'const remaining =')
    .replaceAll('const DWORD waitError =', 'const waitError =')
    .replaceAll('throw NativeError{', 'throw nativeError(')
    .replaceAll('"connect"};', '"connect");')
    .replaceAll('"};', '");')
    .replaceAll('.c_str()', '')
    .replaceAll('nullptr', 'null')
    .replaceAll('L"', '"')
  const ERROR_FILE_NOT_FOUND = 2, ERROR_ACCESS_DENIED = 5, ERROR_SEM_TIMEOUT = 121, ERROR_PIPE_BUSY = 231
  const ERROR_NO_DATA = 232
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
    ERROR_FILE_NOT_FOUND, ERROR_ACCESS_DENIED, ERROR_SEM_TIMEOUT, ERROR_PIPE_BUSY, ERROR_NO_DATA,
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

  // An exhausted budget reports the LAST endpoint condition seen, never the
  // ambiguous deadline word or a connect unknown refusal.
  reset()
  plan.open = [ERROR_PIPE_BUSY]
  plan.wait = [[0, ERROR_SEM_TIMEOUT, 2000]]
  let caught: unknown
  try { connect(endpoint, 3000) } catch (error) { caught = error }
  expect((caught as Error).message).toBe('run_control_connect_busy_timeout_expired')

  // A pipe object absent for the whole budget is a dead or never created
  // listener, its own closed expiry rather than a saturation timeout.
  reset()
  plan.open = [ERROR_FILE_NOT_FOUND]
  plan.wait = [[0, ERROR_FILE_NOT_FOUND, 2000]]
  try { connect(endpoint, 3000) } catch (error) { caught = error }
  expect((caught as Error).message).toBe('run_control_connect_no_listener_expired')

  // Only the last observed endpoint condition classifies the expiry: an early
  // absence never masks a later saturation.
  reset()
  plan.open = [ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY]
  plan.wait = [[0, ERROR_FILE_NOT_FOUND, 0], [0, ERROR_SEM_TIMEOUT, 2000]]
  try { connect(endpoint, 3000) } catch (error) { caught = error }
  expect((caught as Error).message).toBe('run_control_connect_busy_timeout_expired')

  // A deadline spent before the first attempt is idle; no endpoint condition
  // was ever observed and no open is attempted.
  reset()
  try { connect(endpoint, 1000) } catch (error) { caught = error }
  expect((caught as Error).message).toBe('run_control_connect_idle_expired')
  expect(state.opens).toEqual([])

  // A true refusal still publishes the closed connect code with its native errno.
  reset()
  plan.open = [ERROR_ACCESS_DENIED]
  plan.wait = [[1, 0, 0]]
  try { connect(endpoint, 3000) } catch (error) { caught = error }
  expect((caught as { code: string }).code).toBe('run_control_connect_unknown')
  expect((caught as { win32: number }).win32).toBe(ERROR_ACCESS_DENIED)
  expect(state.waits).toEqual([])
  // A closing endpoint is transient saturation: the client retries through it
  // instead of publishing a connect unknown refusal, polling rather than
  // spinning while the listener replaces the spent instance.
  reset()
  plan.open = [ERROR_NO_DATA, ERROR_NO_DATA, 0]
  plan.wait = [[0, ERROR_NO_DATA, 0], [1, 0, 0]]
  expect((connect(endpoint, 3000) as { raw: number }).raw).toBe(7)
  expect(state.opens).toEqual([ERROR_NO_DATA, ERROR_NO_DATA, 0])
  expect(state.slept).toEqual([10])

  // A budget spent against the closing state reports saturation, never idle
  // and never a connect unknown refusal.
  reset()
  plan.open = [ERROR_NO_DATA]
  plan.wait = [[0, ERROR_SEM_TIMEOUT, 2000]]
  try { connect(endpoint, 3000) } catch (error) { caught = error }
  expect((caught as Error).message).toBe('run_control_connect_busy_timeout_expired')

  // The split retires the ambiguous deadline token from the native header.
  expect(source).not.toContain('"run_deadline_expired"')
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

test('run control accept replenishes a spent listening instance instead of refusing', async () => {
  const { runInNewContext } = await import('node:vm')
  const header = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows/WindowsNativeRunControl.hpp')
  const source = (await readFile(header, 'utf8')).replaceAll('\r\n', '\n')
  const acceptBody = source.slice(source.indexOf('JsonObject accept('), source.indexOf('JsonObject read('))
  const begin = acceptBody.indexOf('    const DWORD timeout = runControlTimeoutMs(input, L"timeoutMs");')
  expect(begin).toBeGreaterThanOrEqual(0)
  const end = acceptBody.indexOf('    // The accepted instance remains connected and owned by the registry; no')
  expect(end).toBeGreaterThan(begin)
  const body = acceptBody.slice(begin, end)
    .replaceAll('const DWORD timeout =', 'const timeout =')
    .replaceAll('const std::uint64_t acceptDeadline =', 'const acceptDeadline =')
    .replaceAll('auto owned = std::make_shared<IoOperation>();',
      'const owned = { overlap: {}, error: 0, complete: false, poisoned: false, unresolved: false };')
    .replaceAll('auto operation = runControlRetain(std::move(owned));', 'const operation = runControlRetain(owned);')
    .replaceAll('BOOL connected =', 'let connected =')
    .replaceAll('DWORD error =', 'let error =')
    .replaceAll('auto wait =', 'let wait =')
    .replaceAll('const auto cancelled =', 'const cancelled =')
    .replaceAll('Handle accepted = std::move(operation->issuingHandle);', 'const accepted = operation.issuingHandle;')
    .replaceAll('&operation->overlap', 'operation.overlap')
    .replaceAll('throw NativeError{', 'throw nativeError(')
    .replaceAll('"accept"};', '"accept");')
    .replaceAll('"};', '");')
    .replaceAll('static_cast<bool>(', '(')
    .replaceAll('std::move(', '(')
    .replaceAll('*operation', 'operation')
    .replaceAll('IoKind::accept', '"accept"')
    .replaceAll('owned->', 'owned.')
    .replaceAll('operation->', 'operation.')
    .replaceAll('listener_->', 'listener.')
    .replaceAll('listener_', 'listener')
    .replaceAll('nullptr', 'null')
    .replaceAll('TRUE', 'true')
    .replaceAll('FALSE', 'false')
    .replaceAll('L"', '"')
  const closes = Math.max(0, (body.match(/\{/g) ?? []).length - (body.match(/\}/g) ?? []).length)
  const ERROR_SUCCESS = 0, ERROR_NO_DATA = 232, ERROR_IO_PENDING = 997, ERROR_PIPE_CONNECTED = 535
  const state = { now: 1000, lastError: 0, offers: 0, forgets: 0, waits: 0 }
  const runAccept = (connects: Array<[number, number]>,
    waits: Array<{ completed: boolean; transferred: number; error: number }>,
    retainIdleWait: boolean, tick = 0) => {
    state.now = 1000; state.lastError = 0; state.offers = 0; state.forgets = 0; state.waits = 0
    let connectAt = 0
    const waitPlan = [...waits]
    const listener = { name: '\\\\.\\pipe\\agt-v2-run-control-test', pending: { value: 1 }, poisoned: false }
    const context = {
      require: (value: unknown, code: string) => { if (!value) throw new Error(code) },
      nativeError: (code: string, win32: number) => Object.assign(new Error(code), { code, win32 }),
      runControlTimeoutMs: () => 3000,
      GetTickCount64: () => state.now,
      runControlRemaining: (deadline: number) => Math.max(0, deadline - state.now),
      runControlDuplicateHandle: (handle: number) => ({ value: handle }),
      Handle: (raw: unknown) => raw,
      CreateEventW: () => ({ value: 9 }),
      runControlRetain: (operation: unknown) => operation,
      runControlForget: () => { state.forgets += 1 },
      runControlOfferPending: () => { state.offers += 1; listener.pending = { value: 1 + state.offers } },
      ConnectNamedPipe: () => {
        const entry = connects[Math.min(connectAt++, connects.length - 1)] ?? [1, 0]
        state.lastError = entry[1]
        if (tick) state.now += tick
        return entry[0]
      },
      runControlWaitOperation: () => {
        state.waits += 1
        return waitPlan.shift() ?? { completed: true, transferred: 0, error: 0 }
      },
      runControlCancelAndDrain: () => ({ completed: true, transferred: 0, error: 0 }),
      GetLastError: () => state.lastError,
      lock: { unlock: () => {}, lock: () => {} },
      requestPumpStop_: false, shutdown_: false,
      ERROR_SUCCESS, ERROR_NO_DATA, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, ERROR_OPERATION_ABORTED: 995,
    }
    const accept = runInNewContext(
      `(function () {return function (input, listener, retainIdleWait) {${body}\nreturn accepted;${'}'.repeat(closes + 1)}})()`,
      context) as (input: unknown, listener: unknown, retainIdleWait: boolean) => unknown
    return { result: accept({ timeoutMs: 3000 }, listener, retainIdleWait), listener }
  }

  // A spent offer is never fatal: its only client arrived and left before the
  // listen was issued, so the instance is replaced and the retry accepts on
  // the fresh one inside the same budget without poisoning the listener.
  const outcome = runAccept([[0, ERROR_NO_DATA], [1, 0]], [], true)
  expect((outcome.result as { value: number }).value).toBe(2)
  expect(outcome.listener.poisoned).toBe(false)
  expect(state.offers).toBe(1)
  expect(state.forgets).toBe(2)

  // A completed listen carrying the same spent-instance report takes the
  // identical replenish-and-retry path.
  const retried = runAccept([[0, ERROR_IO_PENDING], [1, 0]],
    [{ completed: true, transferred: 0, error: ERROR_NO_DATA }], true)
  expect((retried.result as { value: number }).value).toBe(2)
  expect(retried.listener.poisoned).toBe(false)
  expect(state.offers).toBe(1)

  // An explicit accept whose budget is eaten by spent offers reports budget
  // expiry, never a listener refusal.
  let caught: unknown
  try {
    runAccept([[0, ERROR_NO_DATA]], [], false, 1000)
  } catch (error) { caught = error }
  expect((caught as Error).message).toBe('run_control_accept_timeout')
  expect(state.offers).toBe(3)
})
test('run state request wall deadline expiry keeps its own closed token', async () => {
  const { runInNewContext } = await import('node:vm')
  const source = await readFile(path.resolve(import.meta.dir, '../../src/services/opencode/host/windows/WindowsKernelScope.cpp'), 'utf8')
  const operation = source.indexOf('if (operation == L"runStateRequest") {')
  expect(operation).toBeGreaterThanOrEqual(0)
  const begin = source.indexOf('      FILETIME wallTime{};', operation)
  expect(begin).toBeGreaterThanOrEqual(0)
  const marker = source.indexOf('require(static_cast<std::uint64_t>(wallDeadline) > nowMs, "', begin)
  expect(marker).toBeGreaterThan(begin)
  const end = source.indexOf('");', marker)
  expect(end).toBeGreaterThan(marker)
  const body = source.slice(begin, end + '");'.length)
    .replaceAll('FILETIME wallTime{};', 'const wallTime = {};')
    .replaceAll('GetSystemTimeAsFileTime(&wallTime);', 'GetSystemTimeAsFileTime(wallTime);')
    .replaceAll('const std::uint64_t nowMs =', 'const nowMs =')
    .replaceAll('static_cast<std::uint64_t>(wallDeadline)', 'wallDeadline')
    .replaceAll('11644473600000ULL', '11644473600000')
  const nowMs = 1_760_000_000_000
  const admit = (wallDeadline: number) => runInNewContext(`(function () {${body}\nreturn 'admitted';})()`, {
    wallDeadline, GetSystemTimeAsFileTime: (value: Record<string, number>) => { value.stamp = (nowMs + 11644473600000) * 10000 },
    filetime: (value: Record<string, number>) => value.stamp,
    require: (value: unknown, code: string) => { if (!value) throw new Error(code) },
  })
  // The caller's wall deadline expiring before any connect work is its own
  // closed branch, never the ambiguous connect/IO deadline word.
  expect(admit(nowMs + 1)).toBe('admitted')
  let caught: unknown
  try { admit(nowMs) } catch (error) { caught = error }
  expect((caught as Error).message).toBe('run_state_wall_deadline_expired')
  expect(source).toContain('require(static_cast<std::uint64_t>(wallDeadline) > nowMs, "run_state_wall_deadline_expired");')
})
test('client request budget expiry is closed apart from the run wall deadline', async () => {
  const { runInNewContext } = await import('node:vm')
  const header = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows/WindowsNativeRunControl.hpp')
  const source = (await readFile(header, 'utf8')).replaceAll('\r\n', '\n')
  const begin = source.indexOf('    const DWORD available = runControlRemaining(deadline);')
  expect(begin).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n    };', begin)
  expect(end).toBeGreaterThan(begin)
  const body = source.slice(begin, end + '\n    };'.length)
    .replaceAll('const DWORD available =', 'const available =')
    .replaceAll('const DWORD replyAllowance =', 'const replyAllowance =')
    .replaceAll('const DWORD cleanupAllowance =', 'const cleanupAllowance =')
    .replaceAll('const std::uint64_t cleanupDeadline =', 'const cleanupDeadline =')
    .replaceAll('const std::uint64_t ioDeadline =', 'const ioDeadline =')
    .replaceAll('const DWORD value =', 'const value =')
    .replaceAll('const auto remaining = [&] {', 'const remaining = () => {')
    .replaceAll('std::min<DWORD>(', 'Math.min(')
    .replaceAll('std::max<DWORD>(', 'Math.max(')
  const attempt = (budget: readonly number[]) => {
    const readings = [] as number[]
    return runInNewContext(`(function () {${body}\nreturn remaining();})()`, {
      deadline: 10_000, stop: true, CANCEL_DRAIN_MS: 5000,
      runControlRemaining: () => {
        const value = budget[Math.min(readings.length, budget.length - 1)] ?? 0
        readings.push(value); return value
      },
      require: (value: unknown, code: string) => { if (!value) throw new Error(code) },
    })
  }
  // A client whose own budget is spent before any frame IO reports that branch,
  // never the wall deadline of the run or an IO read/write code.
  let caught: unknown
  try { attempt([0]) } catch (error) { caught = error }
  expect((caught as Error).message).toBe('run_control_client_budget_exhausted')
  caught = undefined
  try { attempt([2, 0]) } catch (error) { caught = error }
  expect((caught as Error).message).toBe('run_control_client_budget_exhausted')
  expect(attempt([100, 50])).toBe(50)
  // The stop deadline shrink shares the same exhausted-client-budget branch.
  expect(source).toContain('require(available > 1, "run_control_client_budget_exhausted");')
  expect(source).toContain('require(value > 0, "run_control_client_budget_exhausted");')
  expect(source).toContain('require(activeRemaining > replyAllowance, "run_control_client_budget_exhausted");')
  expect(source).not.toContain('require(available > 1, "run_deadline_expired");')
  expect(source).not.toContain('require(value > 0, "run_deadline_expired");')
  expect(source).not.toContain('require(activeRemaining > replyAllowance, "run_deadline_expired");')
})

test('process identity observation retries only transient image failures', async () => {
  const { runInNewContext } = await import('node:vm')
  const windows = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows')
  const source = async (name: string) => (await readFile(path.join(windows, name), 'utf8')).replaceAll('\r\n', '\n')
  const header = await source('WindowsNativeRunControl.hpp')
  const scope = await source('WindowsKernelScope.cpp')
  const slice = (text: string, from: string, to: string) => {
    const begin = text.indexOf(from), end = text.indexOf(to, begin)
    expect(begin).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(begin)
    return text.slice(begin + from.length, end)
  }
  const translate = (body: string) => body
    .replaceAll('FILETIME creation{}, exitTime{}, kernel{}, user{};',
      'let creation = {}, exitTime = {}, kernel = {}, user = {};')
    .replaceAll('NativeError failure{"run_control_process_identity", error, "process_birth"}',
      "failure = { code: 'run_control_process_identity', win32: error, stage: 'process_birth' }")
    .replaceAll('NativeError{"run_control_process_identity", error, "process_birth"}',
      "{ code: 'run_control_process_identity', win32: error, stage: 'process_birth' }")
    .replaceAll('NativeError{', '{')
    .replaceAll('const DWORD error = ', 'const error = ')
    .replaceAll('for (int attempt = 0;; ++attempt)', 'for (let attempt = 0;; ++attempt)')
    .replaceAll('&creation', 'creation').replaceAll('&exitTime', 'exitTime')
    .replaceAll('&kernel', 'kernel').replaceAll('&user', 'user')
  // A transient observation failure is re-observed a bounded number of times;
  // the retry never touches liveness or any pin comparison.
  const birth = (failures: readonly number[]) => {
    let calls = 0
    const sleeps: number[] = []
    const body = translate(slice(header, 'static FILETIME runControlBirth(HANDLE process) {', '\n  }\n'))
    let value: unknown
    try {
      value = runInNewContext(`(function () {${body}\n})()`, {
        process: {},
        GetProcessTimes: (_process: unknown, creation: Record<string, unknown>) => {
          calls += 1
          if (calls <= failures.length) return false
          Object.assign(creation, { observed: true })
          return true
        },
        GetLastError: () => failures[Math.min(calls, failures.length) - 1] ?? 0,
        Sleep: (ms: number) => { sleeps.push(ms) },
        runControlObservationAttempts: 3,
        runControlObservationRetryDelayMs: 25,
        runControlTransientObservation: (failure: { win32: number }) => [31, 32, 33].includes(failure.win32),
      })
    } catch (error) { return { error: error as { code?: string; stage?: string; win32?: number }, calls, sleeps } }
    return { value, calls, sleeps }
  }
  expect(birth([31])).toEqual({ value: { observed: true }, calls: 2, sleeps: [25] })
  expect(birth([31, 32])).toEqual({ value: { observed: true }, calls: 3, sleeps: [25, 25] })
  expect(birth([31, 31, 31])).toEqual({
    error: { code: 'run_control_process_identity', win32: 31, stage: 'process_birth' }, calls: 3, sleeps: [25, 25] })
  // Non-transient refusals and exhausted retries stay single-shot definitive.
  expect(birth([5])).toEqual({
    error: { code: 'run_control_process_identity', win32: 5, stage: 'process_birth' }, calls: 1, sleeps: [] })
  expect(birth([0])).toEqual({
    error: { code: 'run_control_process_identity', win32: 0, stage: 'process_birth' }, calls: 1, sleeps: [] })

  const predicate = translate(slice(header,
    'static bool runControlTransientObservation(const NativeError &failure) {', '\n  }\n'))
    .replaceAll('const std::string stage = ', 'const stage = ')
  const classify = (code: string, stage: string | null, win32: number) => runInNewContext(
    `(function () {${predicate}\n})()`, {
      failure: { code, stage, win32 },
      ERROR_GEN_FAILURE: 31, ERROR_SHARING_VIOLATION: 32, ERROR_LOCK_VIOLATION: 33,
    })
  for (const stage of ['process_birth', 'process_image_path', 'process_image_open'])
    for (const win32 of [31, 32, 33])
      expect(classify('run_control_process_identity', stage, win32)).toBe(true)
  const refused: readonly (readonly [string, string | null, number])[] = [
    ['run_control_process_identity', 'process_alive', 31],
    ['run_control_process_identity', 'process_image_path', 5],
    ['run_control_process_identity', 'process_image_path', 0],
    ['run_control_process_identity', null, 31],
    ['run_control_path_alias', 'process_image_path', 31],
  ]
  for (const [code, stage, win32] of refused) expect(classify(code, stage, win32)).toBe(false)

  // The same bounded observation retry guards the image path, the image pin
  // and the kernel-scope image open; process liveness is never retried.
  expect(header.split('runControlTransientObservation(failure)').length - 1).toBe(3)
  expect(header.split('Sleep(runControlObservationRetryDelayMs);').length - 1).toBe(3)
  expect(slice(header, 'static ProcessPin runControlObserveProcess(HANDLE process,', '\n  }\n')).not.toContain('Sleep(')
  expect(scope).toContain('!Control::runControlTransientObservation(failure)')
  expect(scope).toContain('Sleep(Control::runControlObservationRetryDelayMs);')
})

test('run control frame budgets carry the full broker control packet on every hop', async () => {
  const windows = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows')
  // Windows checkouts carry CRLF; markers and budgets match on normalized lines.
  const read = async (name: string) => (await readFile(name, 'utf8')).replaceAll('\r\n', '\n')
  const header = await read(path.join(windows, 'WindowsNativeRunControl.hpp'))
  const runControl = await read(path.resolve(import.meta.dir, '../../src/services/opencode/bridge/OpenCodeV2RunControl.ts'))
  const broker = await read(path.join(windows, 'OpenCodeV2WindowsNativeBroker.ts'))
  const budget = (source: string, name: string) => {
    const match = source.match(new RegExp(`(?:const|constexpr[^\\n]*?)\\s+${name}\\s*=\\s*([0-9 *]+?);?\\n`))
    expect(match).not.toBeNull()
    return match![1].split('*').map(part => Number(part.trim())).reduce((left, right) => left * right, 1)
  }
  const packet = budget(broker, 'CONTROL_PACKET_LIMIT')
  // A full transcript cut is one control reply: the pipe/socket frame on both
  // peers and the broker stdio packet hops must share one budget, or a large
  // reply is refused mid-flight and its read is silently projected as empty.
  expect(budget(header, 'RUN_CONTROL_MAX_FRAME_BYTES')).toBe(packet)
  expect(budget(runControl, 'MAX_FRAME')).toBe(packet)
  // Record reads keep their own smaller bound; only frames inherit the packet budget.
  expect(budget(runControl, 'MAX_RECORD')).toBe(512 * 1024)
  expect(runControl).toContain('before.size <= MAX_RECORD')
  expect(runControl).toContain('bytes.length <= MAX_RECORD')
  expect(runControl).toContain('bytes.length > MAX_FRAME')
  expect(runControl).toContain('Buffer.byteLength(bytes) <= MAX_FRAME')
})

test('run control pipe buffers stage bytes instead of reserving the frame cap per instance', async () => {
  const windows = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows')
  const read = async (name: string) => (await readFile(name, 'utf8')).replaceAll('\r\n', '\n')
  const header = await read(path.join(windows, 'WindowsNativeRunControl.hpp'))
  const budget = (source: string, name: string) => {
    const match = source.match(new RegExp(`(?:const|constexpr[^\\n]*?)\\s+${name}\\s*=\\s*([0-9 *]+?);?\\n`))
    expect(match).not.toBeNull()
    return match![1].split('*').map(part => Number(part.trim())).reduce((left, right) => left * right, 1)
  }
  const frame = budget(header, 'RUN_CONTROL_MAX_FRAME_BYTES')
  const buffer = budget(header, 'RUN_CONTROL_PIPE_BUFFER_BYTES')
  // The pipe buffers only stage bytes between reads; the read loop assembles
  // the logical 16 MiB frame across them. Reserving the frame cap for both pipe
  // buffers pins ~32 MiB nonpaged per instance (up to MAX_CONNECTIONS + 2) and
  // can make CreateNamedPipeW refuse the instance on modest hosts.
  expect(buffer).toBeLessThan(frame)
  const start = header.indexOf('Handle runControlCreateServer(')
  expect(start).toBeGreaterThan(0)
  const create = header.slice(start, header.indexOf('\n  }\n', start))
  expect(create).toContain('RUN_CONTROL_PIPE_BUFFER_BYTES, RUN_CONTROL_PIPE_BUFFER_BYTES')
  expect(create).not.toContain('MAX_FRAME_BYTES,')
})

test('poison retires a connection the read failure paths already poisoned', async () => {
  const windows = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows')
  const header = (await readFile(path.join(windows, 'WindowsNativeRunControl.hpp'), 'utf8')).replaceAll('\r\n', '\n')
  const start = header.indexOf('void poisonConnection(')
  expect(start).toBeGreaterThan(0)
  const body = header.slice(start, header.indexOf('\n  }\n', start))
  // Read/write failures poison the connection before they throw, so the retire
  // step must tolerate an already-poisoned connection. The strict lookup throws
  // on poisoned entries and both callers swallow that throw, leaving the corpse
  // to hold an accept slot until the listener waits forever for capacity.
  expect(body).toContain('runControlRetire(')
  expect(body).not.toContain('runControlConnectionFor(')
})

test('endpoint owner witness measures retired owners while live observation refuses them', async () => {
  const { runInNewContext } = await import('node:vm')
  const windowsDirectory = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows')
  const source = async (name: string) => (await readFile(path.join(windowsDirectory, name), 'utf8')).replaceAll('\r\n', '\n')
  const header = await source('WindowsNativeRunControl.hpp')
  const scope = await source('WindowsKernelScope.cpp')
  const slice = (text: string, from: string, to: string) => {
    const begin = text.indexOf(from), end = text.indexOf(to, begin)
    expect(begin).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(begin)
    return text.slice(begin + from.length, end)
  }
  const bodyOf = (text: string, from: string) => {
    const begin = text.indexOf(from)
    expect(begin).toBeGreaterThanOrEqual(0)
    const open = text.indexOf(') {', begin), end = text.indexOf('\n  }', open)
    expect(open).toBeGreaterThan(begin); expect(end).toBeGreaterThan(open)
    return text.slice(open + 3, end)
  }
  const flat = (text: string) => text.replace(/\s+/g, ' ')
  // The endpoint witness that fills the run state's retirement handles may run
  // against owners that already exited: ownerRetired observes their exit through
  // exactly these handles. While alive the witness demands the full identity
  // measurement; once retired only the retirement witness form (pid + birth)
  // remains observable and equally conclusive.
  const retain = flat(slice(scope,
    'static void retainOriginalEndpointOwners(State &state, const JsonObject &record) {', '\n  }\n'))
  expect(retain).toContain('Control::runControlHeldIdentityMatches(heldHelper.value, helperPid, State::runStateProcessBirthLocked(helper, "run_control_endpoint_changed"), helper)')
  expect(retain).toContain('Control::runControlHeldIdentityMatches(heldBun.value, bunPid, State::runStateProcessBirthLocked(bun, "run_control_endpoint_changed"), bun)')
  expect(retain).not.toContain('Control::runControlHeldIdentity(')
  expect(retain).not.toContain('runControlNativeIdentity')
  expect(retain).toContain('runStateAssertRetirementWitnessLocked(heldHelper.value, state.helperPid_, state.helperBirth_')
  expect(retain).toContain('runStateAssertRetirementWitnessLocked(heldBun.value, state.bunPid_, state.bunBirth_')
  // Every remaining live measurement names its own subject, so a refused owner
  // can never again surface as a bare process_alive.
  const validate = flat(slice(header, 'void validateRequestPayload(std::uint64_t id, const JsonObject &payload) {', '\n  }\n'))
  expect(validate).toContain('runControlNativeIdentity(connection.peerParent.value, connection.peerParentPin.pid, "process_alive_peer_parent")')
  const currentBun = flat(slice(header, 'JsonObject currentBunIdentity() const {', '\n  }\n'))
  expect(currentBun).toContain('runControlNativeIdentity(intendedBun_.value, GetProcessId(intendedBun_.value), "process_alive_held_bun")')
  const prepare = flat(slice(header, 'void prepareExpectedEndpoint() {', '\n  }\n'))
  expect(prepare).toContain('runControlNativeIdentity(helper.value, helperPid, "process_alive_endpoint_helper")')
  expect(prepare).toContain('runControlNativeIdentity(bun.value, bunPid, "process_alive_endpoint_bun")')

  // Behavioral pair on the extracted measurements: the pin and held identity
  // paths never ask liveness (their image step still needs an observable
  // process - the witness test below covers retired owners) and only the live
  // observation gate refuses an exited owner, under the caller's stage.
  const translate = (body: string) => body
    .replaceAll('const FILETIME first =', 'const first =')
    .replaceAll('const FILETIME second =', 'const second =')
    .replaceAll('ProcessPin pin;', 'const pin = {};')
    .replaceAll('const DWORD status =', 'const status =')
    .replaceAll('const DWORD error =', 'const error =')
    .replaceAll('throw NativeError{', 'throw nativeError(')
    .replaceAll('aliveStage};', 'aliveStage);')
  const waited: number[] = []
  const birth = { observed: true }
  const sandbox: Record<string, unknown> = {
    require: (value: unknown, code: string) => { if (!value) throw new Error(code) },
    nativeError: (code: string, win32: number, stage: string) => Object.assign(new Error(code), { code, win32, stage }),
    WaitForSingleObject: (_process: unknown, timeout: number) => { waited.push(timeout); return 0 },
    GetLastError: () => 0,
    GetProcessId: () => 4242,
    runControlBirth: () => birth,
    runControlSameBirth: (first: unknown, second: unknown) => first === second,
    runControlProcessSid: () => ({ sid: true }),
    runControlProcessImagePin: () => ({ sha256: 'digest' }),
    runControlIdentityJson: (_process: unknown, pid: number, pin: unknown) => ({ pid, pin }),
    WAIT_FAILED: 0xffffffff, WAIT_TIMEOUT: 258,
  }
  type Failure = [string | undefined, number | undefined, string | undefined]
  const failure = (call: () => unknown): Failure | null => {
    try { call() } catch (error) {
      const caught = error as { code?: string; win32?: number; stage?: string }
      return [caught.code, caught.win32, caught.stage]
    }
    return null
  }
  const pin = runInNewContext(`(function (process) {${translate(bodyOf(header, 'static ProcessPin runControlPinProcess(HANDLE process)'))}\n})`, sandbox) as (process: unknown) => unknown
  sandbox.runControlPinProcess = pin
  const observe = runInNewContext(`(function (process, aliveStage = "process_alive") {${translate(bodyOf(header, 'static ProcessPin runControlObserveProcess(HANDLE process,'))}\n})`, sandbox) as (process: unknown, aliveStage?: string) => unknown
  sandbox.runControlObserveProcess = observe
  const native = runInNewContext(`(function (process, pid, aliveStage = "process_alive") {${translate(bodyOf(header, 'static JsonObject runControlNativeIdentity(HANDLE process, DWORD pid,'))}\n})`, sandbox) as (process: unknown, pid: number, aliveStage?: string) => unknown
  const held = runInNewContext(`(function (process, pid) {${translate(bodyOf(header, 'static JsonObject runControlHeldIdentity(HANDLE process, DWORD pid)'))}\n})`, sandbox) as (process: unknown, pid: number) => unknown
  const measured = { pid: 4242, birth: { observed: true }, sid: { sid: true }, image: { sha256: 'digest' } }
  // The pin measurement of an exited owner succeeds on its open handle and
  // never asks the liveness question.
  waited.length = 0
  expect(pin({})).toEqual(measured)
  expect(waited).toEqual([])
  // The live observation gate refuses the same exited owner under the default
  // stage and under each caller's named stage.
  expect(failure(() => observe({}))).toEqual(['run_control_process_identity', 0, 'process_alive'])
  expect(failure(() => observe({}, 'process_alive_peer_parent'))).toEqual(['run_control_process_identity', 0, 'process_alive_peer_parent'])
  expect(failure(() => native({}, 7))).toEqual(['run_control_process_identity', 0, 'process_alive'])
  expect(failure(() => native({}, 7, 'process_alive_held_bun'))).toEqual(['run_control_process_identity', 0, 'process_alive_held_bun'])
  expect(waited).toEqual([0, 0, 0, 0])
  // The held identity of that same exited owner completes with the identical
  // measurement and remains silent about liveness.
  waited.length = 0
  expect(held({}, 7)).toEqual({ pid: 7, pin: measured })
  expect(waited).toEqual([])
})

test('endpoint owner witness accepts retired owners by retirement witness and refuses substituted ones', async () => {
  const { runInNewContext } = await import('node:vm')
  const windowsDirectory = path.resolve(import.meta.dir, '../../src/services/opencode/host/windows')
  const header = (await readFile(path.join(windowsDirectory, 'WindowsNativeRunControl.hpp'), 'utf8')).replaceAll('\r\n', '\n')
  const bodyOf = (text: string, from: string) => {
    const begin = text.indexOf(from)
    expect(begin).toBeGreaterThanOrEqual(0)
    const open = text.indexOf(') {', begin), end = text.indexOf('\n  }', open)
    expect(open).toBeGreaterThan(begin); expect(end).toBeGreaterThan(open)
    return text.slice(open + 3, end)
  }
  // A retired owner is observable only as pid + creation, exactly the
  // retirement witness the run state itself trusts: a recycled PID or a
  // replaced object changes the birth and never passes. A live owner must
  // still present the full recorded identity.
  const body = bodyOf(header, 'static bool runControlHeldIdentityMatches(HANDLE process, DWORD pid,')
  const translate = (text: string) => text
    .replaceAll('catch (const NativeError &)', 'catch (failure)')
    .replaceAll('throw;', 'throw failure;')
  const scenario = {
    wait: [] as number[],
    identityCalls: 0,
    identity: undefined as unknown,
    identityFailure: null as null | { code: string; win32: number; stage: string },
    pid: 4242, birth: 9001, creation: 9001,
  }
  const reset = () => {
    scenario.wait = []
    scenario.identityCalls = 0
    scenario.identity = { token: 'measured' }
    scenario.identityFailure = null
    scenario.pid = 4242
    scenario.birth = 9001
  }
  const sandbox: Record<string, unknown> = {
    WAIT_TIMEOUT: 258, WAIT_OBJECT_0: 0,
    WaitForSingleObject: () => {
      const status = scenario.wait.shift()
      if (status === undefined) throw new Error('unexpected liveness probe')
      return status
    },
    runControlHeldIdentity: () => {
      scenario.identityCalls += 1
      if (scenario.identityFailure)
        throw Object.assign(new Error(scenario.identityFailure.code), scenario.identityFailure)
      return scenario.identity
    },
    runControlCanonicalJson: (value: unknown) => JSON.stringify(value),
    GetProcessId: () => scenario.pid,
    runControlBirth: () => ({ stamp: scenario.birth }),
    filetime: (value: { stamp: number }) => value.stamp,
  }
  type Failure = [string | undefined, number | undefined, string | undefined]
  const failure = (call: () => unknown): Failure | null => {
    try { call() } catch (error) {
      const caught = error as { code?: string; win32?: number; stage?: string }
      return [caught.code, caught.win32, caught.stage]
    }
    return null
  }
  const matches = runInNewContext(`(function (process, pid, creation, record) {${translate(body)}\n})`, sandbox) as (process: unknown, pid: number, creation: number, record: unknown) => boolean
  // A live owner passes only on the full recorded identity.
  reset(); scenario.wait = [258]
  expect(matches({}, 4242, 9001, { token: 'measured' })).toBe(true)
  expect(scenario.identityCalls).toBe(1)
  reset(); scenario.wait = [258]
  expect(matches({}, 4242, 9001, { token: 'substituted' })).toBe(false)
  expect(scenario.identityCalls).toBe(1)
  // A retired owner passes on the retirement witness alone and never attempts
  // the image measurement that already failed in the wild.
  reset(); scenario.wait = [0]
  expect(matches({}, 4242, 9001, { token: 'measured' })).toBe(true)
  expect(scenario.identityCalls).toBe(0)
  // A recycled PID or a different birth never passes on that fallback.
  reset(); scenario.wait = [0]; scenario.pid = 4243
  expect(matches({}, 4242, 9001, { token: 'measured' })).toBe(false)
  reset(); scenario.wait = [0]; scenario.birth = 9002
  expect(matches({}, 4242, 9001, { token: 'measured' })).toBe(false)
  expect(scenario.identityCalls).toBe(0)
  // The owner may retire between the liveness probe and the image step; the
  // same retirement witness then decides. A still-live measurement failure is
  // never papered over.
  reset(); scenario.wait = [258, 0]
  scenario.identityFailure = { code: 'run_control_process_identity', win32: 31, stage: 'process_image_path' }
  expect(matches({}, 4242, 9001, { token: 'measured' })).toBe(true)
  expect(scenario.identityCalls).toBe(1)
  reset(); scenario.wait = [258, 258]
  scenario.identityFailure = { code: 'run_control_process_identity', win32: 5, stage: 'process_image_path' }
  expect(failure(() => matches({}, 4242, 9001, { token: 'measured' }))).toEqual(['run_control_process_identity', 5, 'process_image_path'])
  expect(scenario.identityCalls).toBe(1)
})
