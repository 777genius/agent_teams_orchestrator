import path from 'node:path'
import { dlopen, FFIType, ptr } from 'bun:ffi'

const h = FFIType.u64, p = FFIType.ptr, d = FFIType.u32, b = FFIType.bool
const api = dlopen('kernel32.dll', {
  CreateJobObjectW: { args: [p, p], returns: h }, SetInformationJobObject: { args: [h, d, p, d], returns: b },
  QueryInformationJobObject: { args: [h, d, p, d, p], returns: b }, TerminateJobObject: { args: [h, d], returns: b },
  InitializeProcThreadAttributeList: { args: [p, d, d, p], returns: b }, UpdateProcThreadAttribute: { args: [p, d, h, p, h, p, p], returns: b },
  DeleteProcThreadAttributeList: { args: [p], returns: FFIType.void }, CreateProcessW: { args: [p, p, p, p, b, d, p, p, p, p], returns: b },
  CreateFileW: { args: [p, d, d, p, d, d, h], returns: h }, GetProcessTimes: { args: [h, p, p, p, p], returns: b },
  IsProcessInJob: { args: [h, h, p], returns: b }, GetExitCodeProcess: { args: [h, p], returns: b }, ResumeThread: { args: [h], returns: d },
  WaitForSingleObject: { args: [h, d], returns: d }, CloseHandle: { args: [h], returns: b }, GetLastError: { args: [], returns: d },
  Sleep: { args: [d], returns: FFIType.void },
})
const bytes = (text: string) => Buffer.from(text + '\0', 'utf16le')
const handle = (value: bigint | number) => BigInt(value)
const put = (buffer: Buffer, offset: number, value: bigint | number) => buffer.writeBigUInt64LE(BigInt(value), offset)
function check(ok: unknown, action: string): asserts ok { if (!ok) throw new Error(`${action}:${api.symbols.GetLastError()}`) }
const bufferPins = new Set<Buffer[]>()

// TEST native command primitive. Job and process HANDLEs stay private here.
export function launchNativeCommand(input: { executable: string; args: readonly string[]; cwd: string; env: Record<string, string>; stdinPath: string; stdoutPath: string; stderrPath: string }) {
  const job = handle(api.symbols.CreateJobObjectW(null, null)); check(job !== 0n, 'TEST command Job')
  const owned: bigint[] = [], backing: Buffer[] = []
  bufferPins.add(backing)
  let processHandle = 0n, thread = 0n, attributes: Buffer | undefined, initialized = false
  const active = () => { const info = Buffer.alloc(48); check(api.symbols.QueryInformationJobObject(job, 1, ptr(info), info.length, null), 'TEST command accounting'); return info.readUInt32LE(40) }
  const exited = () => api.symbols.WaitForSingleObject(processHandle, 0) === 0
  const terminate = () => check(api.symbols.TerminateJobObject(job, 99), 'TEST command terminate Job')
  try {
    const limits = Buffer.alloc(144); backing.push(limits); limits.writeUInt32LE(0x2000, 16)
    check(api.symbols.SetInformationJobObject(job, 9, ptr(limits), limits.length), 'TEST command kill-on-close')
    const size = Buffer.alloc(8); backing.push(size); api.symbols.InitializeProcThreadAttributeList(null, 2, 0, ptr(size)); check(api.symbols.GetLastError() === 122, 'TEST command attribute sizing')
    attributes = Buffer.alloc(Number(size.readBigUInt64LE())); backing.push(attributes); check(api.symbols.InitializeProcThreadAttributeList(ptr(attributes), 2, 0, ptr(size)), 'TEST command attributes'); initialized = true
    const jobs = Buffer.alloc(8); put(jobs, 0, job); backing.push(jobs)
    check(api.symbols.UpdateProcThreadAttribute(ptr(attributes), 0, 0x2000dn, ptr(jobs), jobs.length, null, null), 'TEST command atomic Job assignment')
    const security = Buffer.alloc(24); backing.push(security); security.writeUInt32LE(24); security.writeUInt32LE(1, 16)
    const open = (file: string, access: number, disposition: number) => {
      const name = bytes(file); backing.push(name)
      const value = handle(api.symbols.CreateFileW(ptr(name), access, 3, ptr(security), disposition, 0x80, 0n)); check(value !== 0xffffffffffffffffn, 'TEST command owned stdio file'); owned.push(value); return value
    }
    const stdin = open(input.stdinPath, 0x80000000, 3), stdout = open(input.stdoutPath, 0x40000000, 2), stderr = open(input.stderrPath, 0x40000000, 2)
    const inherited = Buffer.alloc(24); [stdin, stdout, stderr].forEach((value, index) => put(inherited, index * 8, value)); backing.push(inherited)
    check(api.symbols.UpdateProcThreadAttribute(ptr(attributes), 0, 0x20002n, ptr(inherited), inherited.length, null, null), 'TEST command explicit handle list')
    const startup = Buffer.alloc(112); startup.writeUInt32LE(112); startup.writeUInt32LE(0x100, 60); put(startup, 80, stdin); put(startup, 88, stdout); put(startup, 96, stderr); put(startup, 104, ptr(attributes))
    const quote = (arg: string) => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
    // cmd consumes its /c tail itself, rather than CRT argv quoting. /d prevents
    // host AutoRun registry commands, and /s gives the explicit outer quote pair.
    const commandLine = path.basename(input.executable).toLowerCase() === 'cmd.exe' && input.args.length === 2 && input.args[0] === '/c'
      ? `${quote(input.executable)} /d /s /c "${input.args[1]}"`
      : [input.executable, ...input.args].map(quote).join(' ')
    const executable = bytes(input.executable), command = bytes(commandLine), cwd = bytes(input.cwd), info = Buffer.alloc(24)
    if (Object.entries(input.env).some(([key, value]) => /[=\0]/.test(key) || value.includes('\0'))) throw new Error('TEST command invalid environment')
    const environment = Buffer.from(Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}\0`).join('') + '\0', 'utf16le')
    backing.push(security, startup, executable, command, cwd, info, environment)
    check(api.symbols.CreateProcessW(ptr(executable), ptr(command), null, null, true, 0x80000 | 4 | 0x400 | 0x08000000, ptr(environment), ptr(cwd), ptr(startup), ptr(info)), 'TEST command CreateProcessW')
    processHandle = info.readBigUInt64LE(); thread = info.readBigUInt64LE(8)
    const creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernelTime = Buffer.alloc(8), user = Buffer.alloc(8), membership = Buffer.alloc(4)
    backing.push(creation, exit, kernelTime, user, membership)
    check(api.symbols.GetProcessTimes(processHandle, ptr(creation), ptr(exit), ptr(kernelTime), ptr(user)), 'TEST command held birth')
    check(api.symbols.IsProcessInJob(processHandle, job, ptr(membership)) && membership.readUInt32LE() === 1 && active() === 1, 'TEST command assigned before resume')
    const outer = process.env.TEST_OUTER_JOB_QUERY_HANDLE
    if (outer) check(api.symbols.IsProcessInJob(processHandle, BigInt(outer), ptr(membership)) && membership.readUInt32LE() === 1, 'TEST command exact outer Job')
    while (owned.length) { check(api.symbols.CloseHandle(owned[owned.length - 1]!), 'TEST command close inherited parent copy'); owned.pop() }
    check(api.symbols.ResumeThread(thread) === 1, 'TEST command resume'); check(api.symbols.CloseHandle(thread), 'TEST command thread close'); thread = 0n
    let closed = false
    return { pid: info.readUInt32LE(16), birthFiletime: creation.readBigUInt64LE().toString(), assignedBeforeResume: true, exactOuterJob: !!outer, active, exited, terminate,
      exitCode() { const code = Buffer.alloc(4); check(api.symbols.GetExitCodeProcess(processHandle, ptr(code)), 'TEST command exit code'); return code.readUInt32LE() },
      close() {
        if (closed) return; closed = true
        const errors: unknown[] = []
        try {
          terminate()
          const deadline = Date.now() + 5000
          while ((!exited() || active() !== 0) && Date.now() < deadline) api.symbols.Sleep(20)
          check(exited() && active() === 0, 'TEST command empty kernel proof')
        } catch (error) { errors.push(error) }
        try { check(api.symbols.CloseHandle(processHandle), 'TEST command process close') } catch (error) { errors.push(error) }
        try { check(api.symbols.CloseHandle(job), 'TEST command Job close') } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, 'TEST command retirement uncertain')
      },
    }
  } catch (error) {
    const errors: unknown[] = [error]
    try {
      terminate()
      const deadline = Date.now() + 5000
      while ((active() !== 0 || (processHandle && !exited())) && Date.now() < deadline) api.symbols.Sleep(20)
      check(active() === 0 && (!processHandle || exited()), 'TEST command failed acquisition empty kernel proof')
    } catch (cleanup) { errors.push(cleanup) }
    for (const value of [thread, processHandle, job]) if (value) try { check(api.symbols.CloseHandle(value), 'TEST command failed acquisition close') } catch (cleanup) { errors.push(cleanup) }
    throw new AggregateError(errors, 'TEST command acquisition failed')
  } finally {
    const errors: unknown[] = []
    for (const value of owned) try { check(api.symbols.CloseHandle(value), 'TEST command stdio close') } catch (error) { errors.push(error) }
    if (initialized && attributes) api.symbols.DeleteProcThreadAttributeList(ptr(attributes))
    // Explicit liveness across DeleteProcThreadAttributeList.
    backing.length = 0
    bufferPins.delete(backing)
    if (errors.length) throw new AggregateError(errors, 'TEST command stdio retirement uncertain')
  }
}
