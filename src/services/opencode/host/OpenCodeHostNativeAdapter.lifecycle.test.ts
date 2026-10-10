import { expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateOpenCodeReadEnvironment } from '../profile/OpenCodeV2ManagedConfig.js'

// Required Linux qualification gate, never a silent skip. Every fixture and
// production private root stays below the caller's explicit project-owned TMPDIR.
// strace must support --kill-on-exit and delay injection (qualification uses 6.12+).
// strace documents delay_enter as delaying entry without replacing the syscall:
// https://github.com/strace/strace/blob/v6.12/doc/strace.1.in
const entry = fileURLToPath(new URL('../../../entrypoints/opencodeV2Server.ts', import.meta.url))
const runner = fileURLToPath(new URL('./fixtures/lateAcquisitionAbort.ts', import.meta.url))
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Lifecycle observation deadline expired')), ms)
    })])
  } finally { clearTimeout(timer) }
}

async function eventually<T>(observe: () => Promise<T | undefined>, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await observe()
    if (value !== undefined) return value
    await sleep(2)
  }
  throw new Error('Required lifecycle boundary was not observed')
}

async function optionalText(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

async function roots(label: string): Promise<string> {
  if (process.platform !== 'linux') throw new Error('Host lifecycle gate requires Linux /proc and strace; no other-platform claim')
  const temporary = process.env.TMPDIR
  if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('TEST-')) {
    throw new Error('Set TMPDIR to an explicit existing project-owned TEST-* directory')
  }
  const canonical = await realpath(temporary)
  const workspace = await realpath(fileURLToPath(new URL('../../../../', import.meta.url)))
  if (!canonical.startsWith(workspace + path.sep)) throw new Error('Lifecycle TMPDIR must be inside this worktree')
  const root = await realpath(await mkdtemp(path.join(canonical, `TEST-r188-host-${label}-`)))
  await Promise.all(['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata', 'TEST-project']
    .map(name => mkdir(path.join(root, name), { mode: 0o700 })))
  await writeFile(path.join(root, '.test-project-owner.json'), JSON.stringify({ task: 'r188-host-lifecycle', root }), { mode: 0o600 })
  return root
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  void done.catch(() => undefined)
  return done
}

async function fdTargets(pid: number): Promise<string[]> {
  try {
    const names = await readdir(`/proc/${pid}/fd`)
    const targets = await Promise.all(names.map(async name => {
      try { return await readlink(`/proc/${pid}/fd/${name}`) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
    }))
    return targets.filter(Boolean)
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

async function ownedListeners(pid: number): Promise<string[]> {
  const sockets = new Set((await fdTargets(pid)).flatMap(target => /^socket:\[(\d+)\]$/.exec(target)?.[1] ?? []))
  const tables = await Promise.all(['tcp', 'tcp6'].map(name => optionalText(`/proc/${pid}/net/${name}`)))
  return tables.flatMap(table => (table ?? '').split('\n').slice(1).filter(line => {
    const columns = line.trim().split(/\s+/)
    return columns[3] === '0A' && sockets.has(columns[9] ?? '')
  }))
}

// This turns red on the reviewed child: a close received before the first start
// loses the caller's nonce, exits unsuccessfully, and cannot prove owned cleanup.
test('fresh private V2 child closes before start with matching ACK, exit zero and no owned listener', async () => {
  const root = await roots('pre-start')
  const executable = await realpath(process.execPath)
  const child = spawn(executable, [entry], { cwd: root, env: privateOpenCodeReadEnvironment(root),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
  const exited = exitOf(child)
  const nonce = randomUUID(), messages: unknown[] = [], listeners: string[] = []
  child.on('message', message => { messages.push(message) })
  let observing = true
  const observer = (async () => {
    while (observing && child.pid) { listeners.push(...await ownedListeners(child.pid)); await sleep(2) }
  })()
  void observer.catch(() => undefined)
  let clean = false
  try {
    if (!child.pid) throw new Error('Fresh child has no captured PID')
    await eventually(async () => (await fdTargets(child.pid!)).length ? true : undefined, 5000)
    await bounded(new Promise<void>((resolve, reject) => {
      child.send({ type: 'close', nonce }, error => error ? reject(error) : resolve())
    }), 2000)
    expect(await bounded(exited, 12_000)).toEqual({ code: 0, signal: null })
    observing = false; await observer
    expect(messages).toContainEqual({ type: 'closed', nonce })
    expect(messages.some(message => typeof message === 'object' && message !== null &&
      'type' in message && message.type === 'ready')).toBe(false)
    expect(listeners).toEqual([])
    expect(await fdTargets(child.pid)).toEqual([])
    expect(await readdir(path.join(root, 'data'))).toEqual([])
    clean = true
  } finally {
    observing = false
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await bounded(exited, 3000)
    await observer
    if (clean) await rm(root, { recursive: true, force: true })
  }
}, 25_000)

// The reviewed adapter checks abort only before executable realpath/hash. This
// gate aborts after the actual Bun executable fd opens, while real delayed read
// syscalls keep that asynchronous hash in flight. It must reject with the caller's
// reason, retire private roots, and never exec a successor or bind a server.
for (const pin of ['2.0.0', '2.0.21'] as const) test(`late ${pin} acquisition abort at real executable read starts no successor`, async () => {
  const selected = process.env.TEST_OPENCODE_STRACE_BINARY
  if (!selected || !path.isAbsolute(selected)) throw new Error('Required verified absolute TEST_OPENCODE_STRACE_BINARY is missing')
  const tracerPath = await realpath(selected)
  if (!(await stat(tracerPath)).isFile()) throw new Error('Required strace path must be a regular binary')
  const root = await roots(`late-${pin}`), executable = await realpath(process.execPath)
  const nativePath = path.join(root, 'TEST-native-identity')
  const nativeBytes = 'test-fixture-literal'
  await writeFile(nativePath, nativeBytes, { mode: 0o600 })
  const digest = createHash('sha256').update(nativeBytes).digest('hex')
  const tracePath = path.join(root, 'syscalls.trace')
  // Full process/network trace: no path filter hides successor exec or bind.
  // Five milliseconds per real read creates a bounded observation window; it
  // does not replace read results, server modules, Bun, or production code.
  const tracer = spawn(tracerPath, ['-f', '-qq', '-yy', '-s', '1', '--kill-on-exit',
    '-e', 'trace=%process,%network,read,pread64,openat,close,write,pwrite64,writev,pwritev,pwritev2',
    '-e', 'inject=read,pread64:delay_enter=5ms', '-o', tracePath,
    executable, runner, root, path.join(root, 'TEST-project'), nativePath, digest, pin],
  { cwd: root, env: privateOpenCodeReadEnvironment(root), detached: true,
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const exited = exitOf(tracer)
  let diagnostics = ''
  tracer.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-8192) })
  let clean = false
  try {
    const readyText = await eventually(() => optionalText(path.join(root, 'ready')), 20_000)
    const ready: unknown = JSON.parse(readyText)
    if (!ready || typeof ready !== 'object' || !('pid' in ready) || typeof ready.pid !== 'number') throw new Error('Invalid runner PID')
    const pid = ready.pid
    const baselineTrace = await readFile(tracePath, 'utf8')
    await writeFile(path.join(root, 'begin'), '')
    await eventually(async () => {
      const privateRoots = (await readdir(path.join(root, 'tmp'))).filter(name => name.startsWith('opencode-v2-read-'))
      if (!privateRoots.length || !(await fdTargets(pid)).includes(executable)) return undefined
      const acquisitionTrace = (await readFile(tracePath, 'utf8')).slice(baselineTrace.length)
      return acquisitionTrace.split('\n').some(line => /\b(?:read|pread64)\(/.test(line) &&
        line.includes(`<${executable}>`)) ? true : undefined
    }, 20_000)
    await writeFile(path.join(root, 'abort'), '')
    expect(await eventually(() => optionalText(path.join(root, 'aborted')), 5000)).toBe('late-executable-abort')
    const exit = await bounded(exited, 25_000)
    if (exit.code !== 0 || exit.signal !== null) throw new Error(`strace/runner did not retire cleanly: ${JSON.stringify(exit)} ${diagnostics}`)
    expect(JSON.parse(await readFile(path.join(root, 'result'), 'utf8'))).toEqual({
      outcome: 'rejected', sameAbortReason: true, aborted: true, error: 'late-executable-abort',
    })
    const trace = await readFile(tracePath, 'utf8')
    expect(Buffer.byteLength(trace)).toBeLessThan(8 * 1024 * 1024)
    const acquisitionTrace = trace.slice(baselineTrace.length)
    const firstRead = acquisitionTrace.split('\n').findIndex(line => /\b(?:read|pread64)\(/.test(line) &&
      line.includes(`<${executable}>`))
    const abortMarker = acquisitionTrace.split('\n').findIndex(line => /\b(?:write|pwrite64|writev|pwritev|pwritev2)\(/.test(line) &&
      line.includes(`<${path.join(root, 'aborted')}>`))
    expect(firstRead).toBeGreaterThanOrEqual(0)
    expect(abortMarker).toBeGreaterThan(firstRead)
    // An initial runner exec is required. Any attempted successor exec, even one
    // that exits before a /proc poll, violates cancellation's observable contract.
    const executions = trace.split('\n').filter(line => /\bexecve(?:at)?\(/.test(line))
    expect(executions.length).toBe(1)
    expect(executions[0]).toContain('execve(')
    expect(trace).not.toMatch(/\b(?:bind|listen)\(/)
    expect(await fdTargets(pid)).toEqual([])
    expect(await readdir(path.join(root, 'tmp'))).toEqual([])
    expect(await readdir(path.join(root, 'TEST-project'))).toEqual([])
    clean = true
  } finally {
    // The captured detached spawn owns this process group. --kill-on-exit also
    // confines every tracee on failure; no foreign PID discovery or signaling.
    if (tracer.exitCode === null && tracer.signalCode === null && tracer.pid) {
      try { process.kill(-tracer.pid, 'SIGKILL') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    await bounded(exited, 5000)
    if (clean) await rm(root, { recursive: true, force: true })
  }
}, 75_000)
