import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from 'bun:ffi'

const utf16 = (text: string) => Buffer.from(text + '\0', 'utf16le')
const pointer = (buffer: Buffer, offset: number, value: number | bigint) => buffer.writeBigUInt64LE(BigInt(value), offset)
const p = FFIType.ptr, h = FFIType.u64, d = FFIType.u32, b = FFIType.bool
const kernel = dlopen('kernel32.dll', {
  CreateJobObjectW: { args: [p, p], returns: h },
  SetInformationJobObject: { args: [h, d, p, d], returns: b },
  QueryInformationJobObject: { args: [h, d, p, d, p], returns: b },
  CreateProcessW: { args: [p, p, p, p, b, d, p, p, p, p], returns: b },
  InitializeProcThreadAttributeList: { args: [p, d, d, p], returns: b },
  UpdateProcThreadAttribute: { args: [p, d, h, p, h, p, p], returns: b },
  DeleteProcThreadAttributeList: { args: [p], returns: FFIType.void },
  ResumeThread: { args: [h], returns: d },
  TerminateProcess: { args: [h, d], returns: b },
  TerminateJobObject: { args: [h, d], returns: b },
  WaitForSingleObject: { args: [h, d], returns: d },
  GetProcessTimes: { args: [h, p, p, p, p], returns: b },
  GetExitCodeProcess: { args: [h, p], returns: b },
  IsProcessInJob: { args: [h, h, p], returns: b },
  GetCurrentProcess: { args: [], returns: h },
  DuplicateHandle: { args: [h, h, h, p, d, b, d], returns: b },
  CreateFileW: { args: [p, d, d, p, d, d, h], returns: h },
  CloseHandle: { args: [h], returns: b },
  GetLastError: { args: [], returns: d },
  lstrlenW: { args: [p], returns: FFIType.i32 },
  LocalFree: { args: [p], returns: p },
  CreateNamedPipeW: { args: [p, d, d, d, d, d, d, p], returns: h },
  ConnectNamedPipe: { args: [h, p], returns: b },
  PeekNamedPipe: { args: [h, p, d, p, p, p], returns: b },
  ReadFile: { args: [h, p, d, p, p], returns: b },
  WriteFile: { args: [h, p, d, p, p], returns: b },
})
const security = dlopen('advapi32.dll', {
  ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [p, d, p, p], returns: b },
  ConvertStringSidToSidW: { args: [p, p], returns: b },
  ConvertSidToStringSidW: { args: [p, p], returns: b },
  FreeSid: { args: [p], returns: p },
  SetNamedSecurityInfoW: { args: [p, d, d, p, p, p, p], returns: d },
})
const userenv = dlopen('userenv.dll', {
  CreateAppContainerProfile: { args: [p, p, p, p, d, p], returns: FFIType.i32 },
  DeleteAppContainerProfile: { args: [p], returns: FFIType.i32 },
})
function check(ok: unknown, action: string): asserts ok {
  if (!ok) throw new Error(`${action}:${kernel.symbols.GetLastError()}`)
}
const addressOf = (value: bigint): Pointer => Number(value) as Pointer
const handleValue = (value: number | bigint) => BigInt(value)
export function createWindowsContainer(name: string) {
  const bytes = utf16(name), output = Buffer.alloc(8)
  const result = userenv.symbols.CreateAppContainerProfile(ptr(bytes), ptr(bytes), ptr(bytes), null, 0, ptr(output))
  check(result === 0, `CreateAppContainerProfile:${result}`)
  const sidAddress = output.readBigUInt64LE(), sidTextOutput = Buffer.alloc(8)
  try {
  check(security.symbols.ConvertSidToStringSidW(addressOf(sidAddress), ptr(sidTextOutput)), 'ConvertSidToStringSidW')
  // CString is UTF-8 only. Read the Windows UTF-16 allocation through Bun's buffer view.
  const address = addressOf(sidTextOutput.readBigUInt64LE())
  const length = kernel.symbols.lstrlenW(address)
  check(length > 0 && length <= 184, 'SID text length')
  const view = Buffer.from(toArrayBuffer(address, 0, (length + 1) * 2))
  const sid = view.subarray(0, length * 2).toString('utf16le')
  kernel.symbols.LocalFree(address); sidTextOutput.fill(0)
  return { sid, address: addressOf(sidAddress), close() { security.symbols.FreeSid(addressOf(sidAddress)); check(userenv.symbols.DeleteAppContainerProfile(ptr(bytes)) === 0, 'DeleteAppContainerProfile') } }  } catch (error) {
    if (sidTextOutput.readBigUInt64LE() !== 0n) kernel.symbols.LocalFree(addressOf(sidTextOutput.readBigUInt64LE()))
    security.symbols.FreeSid(addressOf(sidAddress))
    userenv.symbols.DeleteAppContainerProfile(ptr(bytes))
    throw error
  }
}

export function attemptWindowsAclEscape(target: string): number {
  // A NULL DACL would grant unrestricted access if the child could change it.
  const bytes = utf16(target)
  return security.symbols.SetNamedSecurityInfoW(ptr(bytes), 1, 4, null, null, null, null)
}
function testOuterJob() {
  const text = process.env.TEST_OUTER_JOB_QUERY_HANDLE
  if (!text || !/^\d+$/.test(text) || BigInt(text) === 0n) throw new Error('TEST exact outer Job query handle missing')
  return BigInt(text)
}
export function attemptWindowsJobBreakaway(executable: string) {
  const executableBytes = utf16(executable), command = utf16(`"${executable}" -e "setInterval(()=>{},1000)"`)
  const startup = Buffer.alloc(104); startup.writeUInt32LE(104)
  const info = Buffer.alloc(24)
  if (!kernel.symbols.CreateProcessW(ptr(executableBytes), ptr(command), null, null, false, 4 | 0x01000000 | 0x08000000, null, null, ptr(startup), ptr(info))) return { error: kernel.symbols.GetLastError(), neverResumed: true }
  // Nested libuv Jobs permit inner breakaway. Check the exact outer Job while
  // suspended, never execute candidate code, and retire through acquired handles.
  const processHandle = info.readBigUInt64LE(), thread = info.readBigUInt64LE(8)
  const errors: unknown[] = []
  let result: { error: number; pid: number; birthFiletime: string; outerJobContained: boolean; neverResumed: true; candidateRetired: boolean } | undefined
  try {
    const membership = Buffer.alloc(4), creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernelTime = Buffer.alloc(8), userTime = Buffer.alloc(8)
    check(kernel.symbols.GetProcessTimes(processHandle, ptr(creation), ptr(exit), ptr(kernelTime), ptr(userTime)), 'TEST breakaway held birth')
    check(kernel.symbols.IsProcessInJob(processHandle, testOuterJob(), ptr(membership)), 'TEST breakaway exact outer Job')
    result = { error: 0, pid: info.readUInt32LE(16), birthFiletime: creation.readBigUInt64LE().toString(), outerJobContained: membership.readUInt32LE() === 1, neverResumed: true, candidateRetired: false }
  } catch (error) { errors.push(error) }
  finally {
    try {
      check(kernel.symbols.TerminateProcess(processHandle, 99), 'terminate suspended TEST breakaway candidate')
      check(kernel.symbols.WaitForSingleObject(processHandle, 5000) === 0, 'wait TEST breakaway candidate retirement')
      if (result) result.candidateRetired = true
    } catch (error) { errors.push(error) }
    try { check(kernel.symbols.CloseHandle(thread), 'CloseHandle:TEST breakaway thread') } catch (error) { errors.push(error) }
    try { check(kernel.symbols.CloseHandle(processHandle), 'CloseHandle:TEST breakaway process') } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'TEST breakaway validation or retirement failed')
  if (!result) throw new Error('TEST breakaway result missing')
  return result
}
export function probeWindowsNulAccess() {
  const name = utf16('NUL'), attributes = Buffer.alloc(24)
  attributes.writeUInt32LE(24); attributes.writeUInt32LE(1, 16)
  return [{ name: 'stdin', mask: 0x120089 }, { name: 'stdout', mask: 0x120196 }].map(input => {
    // Exact uv__create_nul_handle masks and inheritance; no ACL modifications.
    const handle = handleValue(kernel.symbols.CreateFileW(ptr(name), input.mask, 3, ptr(attributes), 3, 0, 0n))
    if (handle === 0xffffffffffffffffn) return { ...input, error: kernel.symbols.GetLastError() }
    check(kernel.symbols.CloseHandle(handle), 'CloseHandle:TEST NUL probe')
    return { ...input, error: 0 }
  })
}
export function launchWindowsNativeDescendant(executable: string, markerPath: string, probe?: { script: string; waitMs: number }) {
  if (probe && (!Number.isInteger(probe.waitMs) || probe.waitMs < 1 || probe.waitMs > 5000)) throw new Error('TEST native probe timeout out of bounds')
  const quote = (argument: string) => '"' + argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
  const script = probe?.script ?? `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},JSON.stringify({pid:process.pid,nativeDescendant:true}));setInterval(()=>{},1000)`
  const executableBytes = utf16(executable), command = utf16([executable, '-e', script].map(quote).join(' '))
  const startup = Buffer.alloc(104); startup.writeUInt32LE(104)
  const info = Buffer.alloc(24)
  // Inherit the already curated native child environment and its current Job;
  // no breakaway flags and no inherited handles. Start suspended for validation.
  check(kernel.symbols.CreateProcessW(ptr(executableBytes), ptr(command), null, null, false, 4 | 0x08000000, null, null, ptr(startup), ptr(info)), 'CreateProcessW:TEST native descendant')
  const processHandle = info.readBigUInt64LE(), thread = info.readBigUInt64LE(8)
  const errors: unknown[] = []
  let result: { pid: number; birthFiletime: string; inheritedJob: true; timedOut?: boolean; exitCode?: number } | undefined
  try {
    const inJob = Buffer.alloc(4)
    check(kernel.symbols.IsProcessInJob(processHandle, testOuterJob(), ptr(inJob)) && inJob.readUInt32LE() === 1, 'TEST descendant inherited exact outer Job')
    const creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernelTime = Buffer.alloc(8), userTime = Buffer.alloc(8)
    check(kernel.symbols.GetProcessTimes(processHandle, ptr(creation), ptr(exit), ptr(kernelTime), ptr(userTime)), 'TEST descendant birth')
    check(kernel.symbols.ResumeThread(thread) === 1, 'TEST descendant resume')
    result = { pid: info.readUInt32LE(16), birthFiletime: creation.readBigUInt64LE().toString(), inheritedJob: true }
    if (probe) {
      const wait = kernel.symbols.WaitForSingleObject(processHandle, probe.waitMs)
      check(wait === 0 || wait === 258, 'wait TEST native spawn probe')
      result.timedOut = wait === 258
      if (result.timedOut) {
        check(kernel.symbols.TerminateProcess(processHandle, 99), 'terminate timed-out TEST spawn probe')
        check(kernel.symbols.WaitForSingleObject(processHandle, 5000) === 0, 'wait timed-out TEST spawn probe')
      }
      const exitCode = Buffer.alloc(4)
      check(kernel.symbols.GetExitCodeProcess(processHandle, ptr(exitCode)), 'TEST spawn probe exit code')
      result.exitCode = exitCode.readUInt32LE()
    }
  } catch (error) {
    errors.push(error)
    try {
      check(kernel.symbols.TerminateProcess(processHandle, 99), 'cleanup TEST descendant acquisition')
      check(kernel.symbols.WaitForSingleObject(processHandle, 5000) === 0, 'wait TEST descendant acquisition cleanup')
    } catch (cleanupError) { errors.push(cleanupError) }
  } finally {
    try { check(kernel.symbols.CloseHandle(thread), 'CloseHandle:TEST descendant thread') } catch (error) { errors.push(error) }
    try { check(kernel.symbols.CloseHandle(processHandle), 'CloseHandle:TEST descendant process') } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'TEST native descendant acquisition or handle cleanup failed')
  if (!result) throw new Error('TEST native descendant result missing')
  return result
}
export function createWindowsPipe(name: string, sid: string) {
  const descriptor = Buffer.alloc(8), text = utf16(`D:P(A;;GA;;;SY)(A;;GA;;;OW)(A;;GRGW;;;${sid})S:(ML;;NW;;;LW)`)
  check(security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(text), 1, ptr(descriptor), null), 'pipe security')
  const attributes = Buffer.alloc(24); attributes.writeUInt32LE(24); pointer(attributes, 8, descriptor.readBigUInt64LE())
  const pipeName = utf16(name)
  const handle = handleValue(kernel.symbols.CreateNamedPipeW(ptr(pipeName), 3 | 0x80000, 1 | 8, 1, 65536, 65536, 0, ptr(attributes)))
  kernel.symbols.LocalFree(addressOf(descriptor.readBigUInt64LE()))
  check(handle !== 0xffffffffffffffffn, 'CreateNamedPipeW')
  let connected = false
  return {
    read(): string {
      if (!connected) {
        const accepted = kernel.symbols.ConnectNamedPipe(handle, null), error = kernel.symbols.GetLastError()
        if (!accepted && error !== 535) { check(error === 536, 'ConnectNamedPipe'); return '' }
        connected = true
      }
      const available = Buffer.alloc(4)
      if (!kernel.symbols.PeekNamedPipe(handle, null, 0, null, ptr(available), null)) return ''
      const count = available.readUInt32LE(); if (count === 0) return ''
      check(count <= 65536, 'pipe budget')
      const data = Buffer.alloc(count), received = Buffer.alloc(4)
      check(kernel.symbols.ReadFile(handle, ptr(data), count, ptr(received), null), 'ReadFile')
      return data.subarray(0, received.readUInt32LE()).toString('utf8')
    },
    write(text: string) {
      const data = Buffer.from(text), written = Buffer.alloc(4)
      check(kernel.symbols.WriteFile(handle, ptr(data), data.length, ptr(written), null) && written.readUInt32LE() === data.length, 'WriteFile')
    },
    close() { check(kernel.symbols.CloseHandle(handle), 'CloseHandle:pipe') },
  }
}
const launchBufferPins = new Set<Buffer[]>()
export function launchWindowsContainer(input: { containerSid: number; executable: string; arguments: readonly string[]; cwd: string; outputPath: string; env: Record<string, string>; onEnvironmentShape?: (shape: { unicode: true; doubleNull: boolean; bytes: number }) => void }) {
  const job = handleValue(kernel.symbols.CreateJobObjectW(null, null)); check(job !== 0n, 'CreateJobObjectW')
  let processHandle = 0n, thread = 0n
  let attributeAddress: Pointer | undefined, initialized = false, capabilityAddress: Pointer | undefined
  const backing: Buffer[] = []; launchBufferPins.add(backing)
  const stdioHandles: bigint[] = []
  try {
  const limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000, 16) // KILL_ON_JOB_CLOSE; no breakaway flags.
  check(kernel.symbols.SetInformationJobObject(job, 9, ptr(limits), limits.length), 'SetInformationJobObject')
  const size = Buffer.alloc(8)
  kernel.symbols.InitializeProcThreadAttributeList(null, 3, 0, ptr(size))
  check(kernel.symbols.GetLastError() === 122, 'attribute sizing')
  const attributes = Buffer.alloc(Number(size.readBigUInt64LE()))
  backing.push(attributes)
  attributeAddress = ptr(attributes)
  check(kernel.symbols.InitializeProcThreadAttributeList(attributeAddress, 3, 0, ptr(size)), 'attributes')
  initialized = true
  const internet = Buffer.alloc(8), internetText = utf16('S-1-15-3-1')
  check(security.symbols.ConvertStringSidToSidW(ptr(internetText), ptr(internet)), 'internet SID')
  capabilityAddress = addressOf(internet.readBigUInt64LE())
  const capability = Buffer.alloc(16); pointer(capability, 0, internet.readBigUInt64LE()); capability.writeUInt32LE(4, 8)
  const caps = Buffer.alloc(24); pointer(caps, 0, input.containerSid); pointer(caps, 8, ptr(capability)); caps.writeUInt32LE(1, 16)
  const jobs = Buffer.alloc(8); pointer(jobs, 0, job)
  backing.push(capability, caps, jobs)
  check(kernel.symbols.UpdateProcThreadAttribute(ptr(attributes), 0, 0x20009n, ptr(caps), caps.length, null, null), 'security capabilities')
  check(kernel.symbols.UpdateProcThreadAttribute(ptr(attributes), 0, 0x2000dn, ptr(jobs), jobs.length, null, null), 'job list')
  const startup = Buffer.alloc(112); startup.writeUInt32LE(112); pointer(startup, 104, ptr(attributes))
  // Only TEST stdio and an exact JOB_OBJECT_QUERY(4) duplicate cross this
  // checkpoint boundary. The query duplicate is TEST-only, never production.
  const inheritable = Buffer.alloc(24); inheritable.writeUInt32LE(24); inheritable.writeUInt32LE(1, 16)
  const outputPath = utf16(input.outputPath), nullPath = utf16('NUL')
  const openStdio = (file: Buffer, access: number, disposition: number) => {
    const handle = handleValue(kernel.symbols.CreateFileW(ptr(file), access, 3, ptr(inheritable), disposition, 0x80, 0n))
    check(handle !== 0xffffffffffffffffn, 'CreateFileW:TEST stdio')
    stdioHandles.push(handle); return handle
  }
  const stdout = openStdio(outputPath, 0x40000000, 2), stdin = openStdio(nullPath, 0x80000000, 3)
  const queryOutput = Buffer.alloc(8), current = handleValue(kernel.symbols.GetCurrentProcess())
  check(kernel.symbols.DuplicateHandle(current, job, current, ptr(queryOutput), 4, true, 0), 'DuplicateHandle:TEST outer Job query-only')
  const queryJob = queryOutput.readBigUInt64LE(); stdioHandles.push(queryJob)
  const handles = Buffer.alloc(24); pointer(handles, 0, stdout); pointer(handles, 8, stdin); pointer(handles, 16, queryJob)
  backing.push(inheritable, outputPath, nullPath, handles)
  check(kernel.symbols.UpdateProcThreadAttribute(ptr(attributes), 0, 0x20002n, ptr(handles), handles.length, null, null), 'TEST stdio handle list')
  startup.writeUInt32LE(0x100, 60); pointer(startup, 80, stdin); pointer(startup, 88, stdout); pointer(startup, 96, stdout)
  const processInfo = Buffer.alloc(24), executable = utf16(input.executable), cwd = utf16(input.cwd)
  // Windows CommandLineToArgvW-compatible quoting, including terminal backslashes.
  const quote = (argument: string) => '"' + argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
  const command = utf16([input.executable, ...input.arguments].map(quote).join(' '))
  const environment = Buffer.from(Object.entries({ ...input.env, TEST_OUTER_JOB_QUERY_HANDLE: queryJob.toString() }).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}\0`).join('') + '\0', 'utf16le')
  const doubleNull = environment.length >= 4 && environment.readUInt32LE(environment.length - 4) === 0
  input.onEnvironmentShape?.({ unicode: true, doubleNull, bytes: environment.length })
  check(doubleNull, 'Unicode environment termination')
  backing.push(startup, processInfo, executable, cwd, command, environment)
    check(kernel.symbols.CreateProcessW(ptr(executable), ptr(command), null, null, true, 0x80000 | 4 | 0x400 | 0x08000000,
      ptr(environment), ptr(cwd), ptr(startup), ptr(processInfo)), 'CreateProcessW')
  processHandle = processInfo.readBigUInt64LE(); thread = processInfo.readBigUInt64LE(8)
  while (stdioHandles.length) {
    const handle = stdioHandles[stdioHandles.length - 1]!
    check(kernel.symbols.CloseHandle(handle), 'CloseHandle:TEST stdio')
    stdioHandles.pop()
  }
  const pid = processInfo.readUInt32LE(16)
  const active = () => {
    const accounting = Buffer.alloc(48)
    check(kernel.symbols.QueryInformationJobObject(job, 1, ptr(accounting), accounting.length, null), 'QueryInformationJobObject')
    return accounting.readUInt32LE(40)
  }
  const creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernelTime = Buffer.alloc(8), userTime = Buffer.alloc(8)
  check(kernel.symbols.GetProcessTimes(processHandle, ptr(creation), ptr(exit), ptr(kernelTime), ptr(userTime)), 'GetProcessTimes')
  check(active() === 1, 'job assigned before resume')
  check(kernel.symbols.ResumeThread(thread) === 1, 'ResumeThread')
  check(kernel.symbols.CloseHandle(thread), 'CloseHandle:thread'); thread = 0n
  let closed = false
  return { pid, birthFiletime: creation.readBigUInt64LE().toString(), active,
    exited: () => kernel.symbols.WaitForSingleObject(processHandle, 0) === 0,
    exitCode() { const code = Buffer.alloc(4); check(kernel.symbols.GetExitCodeProcess(processHandle, ptr(code)), 'GetExitCodeProcess'); return code.readUInt32LE() },
    terminate() { check(kernel.symbols.TerminateJobObject(job, 99), 'TerminateJobObject') },
    close() { if (closed) return; closed = true; check(kernel.symbols.CloseHandle(job), 'CloseHandle:job'); check(kernel.symbols.CloseHandle(processHandle), 'CloseHandle:process') },
  }
  } catch (error) {
    // A suspended process is already a job member; no failed acquisition leaves it live.
    const cleanup: string[] = []
    if (!kernel.symbols.TerminateJobObject(job, 99)) cleanup.push('terminate')
    if (thread !== 0n && !kernel.symbols.CloseHandle(thread)) cleanup.push('thread')
    if (processHandle !== 0n && !kernel.symbols.CloseHandle(processHandle)) cleanup.push('process')
    if (!kernel.symbols.CloseHandle(job)) cleanup.push('job')
    if (cleanup.length) throw new Error(`native acquisition cleanup uncertain:${cleanup.join(',')}`, { cause: error })
    throw error
  } finally {
    // These remain only when acquisition failed; its catch already retired the job.
    const stdioCleanupErrors: string[] = []
    for (const handle of stdioHandles) if (!kernel.symbols.CloseHandle(handle)) stdioCleanupErrors.push('TEST stdio')
    if (initialized && attributeAddress) kernel.symbols.DeleteProcThreadAttributeList(attributeAddress)
    if (capabilityAddress) kernel.symbols.LocalFree(capabilityAddress)
    launchBufferPins.delete(backing)
    if (stdioCleanupErrors.length) throw new Error('native stdio acquisition cleanup uncertain')
  }
}
