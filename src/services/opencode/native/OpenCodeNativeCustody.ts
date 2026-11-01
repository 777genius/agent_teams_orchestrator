import { OpenCodeNativeRequestOwners } from './OpenCodeNativeRequestOwners.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { Transform, type Readable } from 'node:stream'
import {
  createNativeEpochImages, verifyNativeImage, verifyNativeEpochDirectories, validateNativeProfileRoot,
  type NativeEpochImages, type NativeFileIdentity,
} from './OpenCodeLaunchImage.js'
import { nativeAuthorityPath, nativeExitConfirmed, readNativeAuthority, withNativeAuthorityGate, writeNativeAuthority, type NativeAuthority } from './OpenCodeNativeAuthority.js'
import { compareOpenCodeNativeVersions } from '../OpenCodeNativePolicy.js'

export type NativeCustodyReference = Readonly<{
  schemaVersion: 1; platform: 'linux'; epoch: string; baseUrl: string; bootId: string
  nativePid: number; nativeBirth: string; custodianPid: number; custodianBirth: string
  images: NativeEpochImages; profileRoot: string; scopeDigest: string; authorization: string; measuredVersion: string
}>
type NativeCustody = Readonly<{
  reference: NativeCustodyReference; child: ChildProcess | null
  stdout: Readable | null; stderr: Readable | null
  verify(): Promise<void>; verifyPeer(clientPort: number): Promise<void>; stopExact(): Promise<void>
}>
const admitted = new WeakSet<object>()
const byEndpoint = new Map<string, NativeCustody>()
const byChild = new WeakMap<ChildProcess, NativeCustody>()
// Retain an unconfirmed helper handle; never reinterpret its PID as fresh authority.
const retainedHelpers = new Set<ChildProcess>()
const HELPER_CLEANUP_UNCONFIRMED = 'native_custody_helper_cleanup_unconfirmed'
function cleanupUnconfirmed(error: unknown): boolean {
  return error instanceof Error && error.message === HELPER_CLEANUP_UNCONFIRMED
}

/** Redact complete private byte sequences even when native writes split them across chunks. */
function privateNativeOutput(input: Readable | null, authorization: string): Readable | null {
  if (!input) return null
  const encoded = authorization.slice('Basic '.length)
  const password = Buffer.from(encoded, 'base64').toString('utf8').slice('opencode:'.length)
  const patterns = [authorization, encoded, password].map(value => Buffer.from(value))
  const lookahead = Math.max(...patterns.map(value => value.length)) - 1
  let pending = Buffer.alloc(0)
  const release = (final: boolean): Buffer => {
    const limit = final ? pending.length : Math.max(0, pending.length - lookahead)
    const chunks: Buffer[] = []
    let cursor = 0, start = 0
    while (cursor < limit) {
      const matched = patterns.find(value => pending.subarray(cursor, cursor + value.length).equals(value))
      if (matched) {
        chunks.push(pending.subarray(start, cursor), Buffer.from('[redacted]'))
        cursor += matched.length; start = cursor
      } else cursor++
    }
    chunks.push(pending.subarray(start, cursor)); pending = pending.subarray(cursor)
    return Buffer.concat(chunks)
  }
  const output = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending = Buffer.concat([pending, chunk]); done(null, release(false))
    },
    flush(done) { done(null, release(true)) },
  })
  input.once('error', () => output.destroy(new Error('native_custody_output_failed')))
  // Output errors are phase-only, and remain handled even before its consumer attaches.
  output.on('error', () => undefined)
  return input.pipe(output)
}
function authorityFile(reference: NativeCustodyReference): string {
  return path.join(path.dirname(path.dirname(reference.images.root)), 'current-custody.json')
}
async function verifyAuthority(reference: NativeCustodyReference, stopping = false): Promise<NativeAuthority> {
  const authority = await readNativeAuthority(authorityFile(reference))
  fact(authority.phase === (stopping ? 'stopping' : 'published') && authority.profileRoot === reference.profileRoot &&
    authority.scopeDigest === reference.scopeDigest && JSON.stringify(authority.images) === JSON.stringify(reference.images) &&
    JSON.stringify(authority.reference) === JSON.stringify(reference))
  return authority
}

function fact(value: unknown): asserts value {
  if (!value) throw new Error('native_custody_unavailable')
}
function record(value: unknown): Record<string, unknown> {
  fact(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>
}
function decimal(value: unknown): value is string { return typeof value === 'string' && /^[0-9]{1,20}$/.test(value) }
function frame(fields: string[]): Buffer {
  const chunks = fields.map(value => {
    fact(!value.includes('\0')); const bytes = Buffer.from(value), length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes])
  })
  const body = Buffer.concat(chunks); fact(body.length > 0 && body.length <= 256000)
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length); return Buffer.concat([length, body])
}
type HelperWaitPhase = 'unspecified' | 'hello' | 'measure-terminal' | 'launch-started' | 'control-inspect' | 'control-peer' | 'control-stop'
type HelperTrigger = 'none' | 'invalid-frame' | 'child-error' | 'child-close' | 'stdout-end' | 'stdout-error' | 'stdin-error' | 'timeout'
/** Diagnostic facts from the original handle only. Never used as admission or death authority. */
type HelperDiagnostic = {
  waitPhase: HelperWaitPhase; trigger: HelperTrigger; exitObserved: boolean; closeObserved: boolean
  exitCode: number | null; signal: string | null; bufferedBytes: number; queuedFrames: number; waitingReplies: number; bufferedAtTrigger: number; waitingAtTrigger: number
}
const helperDiagnostics = new WeakMap<object, () => HelperDiagnostic>()
export function nativeHelperFailureDiagnostic(error: unknown): HelperDiagnostic | undefined {
  // WeakMap identity avoids invoking error getters/toJSON or accepting caller data.
  return error !== null && typeof error === 'object' ? helperDiagnostics.get(error)?.() : undefined
}
function frames(child: ChildProcess): { next(phase?: HelperWaitPhase): Promise<Record<string, unknown>>; assertOpen(): void } {
  let data = Buffer.alloc(0), failure: Error | undefined, ended = false
  let waitPhase: HelperWaitPhase = 'unspecified', trigger: HelperTrigger = 'none', bufferedAtTrigger = 0, waitingAtTrigger = 0
  let exitObserved = false, closeObserved = false, exitCode: number | null = null, signal: string | null = null
  const queue: Array<Record<string, unknown>> = [], waiting: Array<{ resolve(value: Record<string, unknown>): void; reject(reason: unknown): void }> = []
  const diagnostic = (): HelperDiagnostic => ({ waitPhase, trigger, exitObserved, closeObserved, exitCode, signal,
    bufferedBytes: Math.min(data.length, 32769), queuedFrames: Math.min(queue.length, 32769), waitingReplies: Math.min(waiting.length, 32769), bufferedAtTrigger, waitingAtTrigger })
  const problem = (code: 'native_custody_protocol' | 'native_custody_timeout' | 'native_custody_unavailable') => {
    const error = new Error(code); helperDiagnostics.set(error, diagnostic); return error
  }
  const mark = (cause: HelperTrigger) => { if (trigger === 'none') {
    trigger = cause; bufferedAtTrigger = Math.min(data.length, 32769); waitingAtTrigger = Math.min(waiting.length, 32769)
  } }
  const refuse = (cause: HelperTrigger) => {
    mark(cause); failure = problem('native_custody_protocol'); for (const waiter of waiting.splice(0)) waiter.reject(failure)
  }
  const finish = (cause: 'child-close' | 'stdout-end') => {
    mark(cause); ended = true
    if (data.length) { refuse(cause); return }
    for (const waiter of waiting.splice(0)) waiter.reject(problem('native_custody_protocol'))
  }
  child.once('exit', (code, observedSignal) => {
    exitObserved = true; exitCode = Number.isSafeInteger(code) ? code : null
    // Node supplies a signal enum; retain only a fixed finite set, never arbitrary text.
    signal = observedSignal === null ? null : ['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT',
      'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2', 'SIGXCPU', 'SIGXFSZ']
      .includes(observedSignal) ? observedSignal : 'other'
  })
  child.stdout!.on('data', (chunk: Buffer) => {
    if (failure || ended) return
    data = Buffer.concat([data, chunk]); if (data.length > 32768) { refuse('invalid-frame'); return }
    while (data.length >= 4) {
      const size = data.readUInt32BE(); if (!size || size > 16384) { refuse('invalid-frame'); return }
      if (data.length < 4 + size) break
      try {
        const value = record(JSON.parse(data.subarray(4, size + 4).toString('utf8')))
        fact(value.protocol === 1); data = data.subarray(size + 4)
        const waiter = waiting.shift(); if (waiter) waiter.resolve(value); else queue.push(value)
      } catch { refuse('invalid-frame'); return }
    }
  })
  child.once('error', () => refuse('child-error'))
  child.once('close', () => { closeObserved = true; finish('child-close') })
  child.stdout!.once('end', () => finish('stdout-end')); child.stdout!.once('error', () => refuse('stdout-error'))
  child.stdin!.on('error', () => refuse('stdin-error'))
  return { assertOpen: () => { if (failure) throw failure; if (ended) throw problem('native_custody_unavailable') }, next: async (phase = 'unspecified') => {
    waitPhase = phase
    if (failure) throw failure
    if (queue.length) return queue.shift()!
    if (ended) throw problem('native_custody_protocol')
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject }; waiting.push(pending)
      const timer = setTimeout(() => { const index = waiting.indexOf(pending); if (index >= 0) waiting.splice(index, 1); mark('timeout'); reject(problem('native_custody_timeout')) }, 10000)
      pending.resolve = value => { clearTimeout(timer); resolve(value) }
      pending.reject = error => { clearTimeout(timer); reject(error) }
    })
  } }
}

/** Attach synchronously in the spawn turn, before receipt closure or any other await.
 * Exported only within the native boundary so lifecycle races can be tested without a native launch. */
export function observeNativeHelper(child: ChildProcess) {
  retainedHelpers.add(child)
  let closed = false, exited = false
  const closure = new Promise<void>(resolve => child.once('close', () => {
    closed = true; retainedHelpers.delete(child); resolve()
  }))
  child.once('exit', () => { exited = true })
  const waitForClose = async (milliseconds: number): Promise<boolean> => {
    if (closed) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([closure, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds) })]) }
    finally { clearTimeout(timer) }
    return closed
  }
  const closeUnadmitted = async (): Promise<boolean> => {
    // No launch/control packet has been sent. Only this captured helper can be stopped.
    child.stdin?.destroy()
    for (const output of child.stdio.slice(1)) (output as Readable | null)?.resume?.()
    try { if (!closed && !exited) child.kill('SIGTERM') } catch { /* Keep observing captured closure. */ }
    if (await waitForClose(750)) return true
    try { if (!closed && !exited) child.kill('SIGKILL') } catch { /* Unconfirmed handle stays retained. */ }
    return waitForClose(2500)
  }
  const stream = frames(child)
  const assertLive = () => { stream.assertOpen(); fact(!exited && !closed) }
  return { stream, closeUnadmitted, assertLive }
}

/** Verify the actual spawned helper image before writing any environment/control packet. */
async function openHelper(images: NativeEpochImages, launch = false, measure = false) {
  await verifyNativeEpochDirectories(images)
  await verifyNativeImage(images.helper, images.helperIdentity)
  let receipt: Awaited<ReturnType<typeof open>> | undefined
  let launched: ChildProcess | undefined, receiptCloseFailed = false
  let observation: ReturnType<typeof observeNativeHelper> | undefined
  try {
    if (launch) {
      fact(images.exitReceipt.file === path.join(images.root, 'native-exit.json'))
      receipt = await open(images.exitReceipt.file, constants.O_WRONLY | constants.O_NOFOLLOW)
      const observed = await receipt.stat({ bigint: true })
      fact(observed.isFile() && observed.nlink === 1n && observed.uid === BigInt(process.getuid!()) &&
        (observed.mode & 0o777n) === 0o600n && observed.size === 0n &&
        String(observed.dev) === images.exitReceipt.dev && String(observed.ino) === images.exitReceipt.ino)
    }
    launched = spawn(images.helper, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe',
      launch || measure ? 'pipe' : 'ignore', launch ? 'pipe' : 'ignore', receipt?.fd ?? 'ignore'], detached: true })
    observation = observeNativeHelper(launched)
  } finally {
    try { await receipt?.close() }
    catch {
      if (!launched) throw new Error('native_custody_receipt_close_failed')
      receiptCloseFailed = true
    }
  }
  fact(launched && observation)
  const child = launched
  const { stream, closeUnadmitted, assertLive } = observation
  try {
    fact(!receiptCloseFailed)
    const hello = await stream.next('hello')
    fact(child.pid && hello.pid === child.pid && decimal(hello.birth) && hello.dev === images.helperIdentity.dev &&
      hello.ino === images.helperIdentity.ino && typeof hello.bootId === 'string')
    const loaded = await lstat(`/proc/${child.pid}/exe`).then(async () => {
      const fd = await open(`/proc/${child.pid}/exe`, constants.O_RDONLY)
      try { return await fd.stat({ bigint: true }) } finally { await fd.close() }
    })
    fact(String(loaded.dev) === images.helperIdentity.dev && String(loaded.ino) === images.helperIdentity.ino)
    await verifyNativeImage(images.helper, images.helperIdentity)
    fact((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() === hello.bootId)
    assertLive()
    return { child, stream, hello, closeUnadmitted, assertLive }
  } catch (error) {
    if (!await closeUnadmitted()) throw new Error(HELPER_CLEANUP_UNCONFIRMED)
    throw error
  }
}

/** The copied object is measured before the real profile or HTTP key is sent. */
async function measurePrivateImage(images: NativeEpochImages, minimum: '1.16.0' | '1.18.0', lifetime: { created(): void; closed(): void }, signal?: AbortSignal): Promise<string> {
  const probe = await openHelper(images, false, true)
  let output = Buffer.alloc(0), overflow = false
  const stdout = probe.child.stdio[3] as Readable
  const ended = new Promise<void>((resolve, reject) => { stdout.once('end', resolve); stdout.once('error', reject) })
  void ended.catch(() => undefined)
  stdout.on('data', (bytes: Buffer) => { if (output.length + bytes.length <= 4096) output = Buffer.concat([output, bytes]); else overflow = true })
  let packetSent = false
  try {
    signal?.throwIfAborted()
    const env = ['PATH=/usr/bin:/bin', `HOME=${path.join(images.probeRoot, 'home')}`,
      `XDG_CONFIG_HOME=${path.join(images.probeRoot, 'config')}`, `XDG_DATA_HOME=${path.join(images.probeRoot, 'data')}`,
      `XDG_CACHE_HOME=${path.join(images.probeRoot, 'cache')}`, `XDG_STATE_HOME=${path.join(images.probeRoot, 'state')}`,
      `TMPDIR=${path.join(images.probeRoot, 'tmp')}`, 'NO_COLOR=1', 'NODE_ENV=production', 'OPENCODE_CONFIG_CONTENT={}']
    const packet = frame(['measure', images.epoch, images.image, images.probeRoot, 'ephemeral',
      images.imageIdentity.dev, images.imageIdentity.ino, '2', images.image, '--version', String(env.length), ...env])
    signal?.throwIfAborted(); probe.assertLive(); lifetime.created(); packetSent = true; probe.child.stdin!.end(packet)
    const terminal = await probe.stream.next('measure-terminal')
    fact(terminal.closed === true); lifetime.closed()
    fact(terminal.status === 0)
    await ended
    signal?.throwIfAborted()
    fact(!overflow)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(output)
    const match = /^(?:opencode v)?((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:\r?\n)?$/.exec(text)
    const version = match?.[1]
    fact(match?.[0] === text && version && version.startsWith('1.'))
    const comparison = compareOpenCodeNativeVersions(version, minimum)
    fact(comparison !== null && comparison >= 0)
    await verifyNativeImage(images.image, images.imageIdentity)
    return version
  } catch (error) {
    if (!packetSent && !await probe.closeUnadmitted()) throw new Error(HELPER_CLEANUP_UNCONFIRMED)
    throw error
  } finally { probe.child.stdin?.end() }
}

async function control(reference: NativeCustodyReference, action: 'inspect' | 'peer' | 'stop', clientPort?: number): Promise<void> {
  await verifyAuthority(reference, action === 'stop')
  await validateNativeProfileRoot(reference.profileRoot)
  await verifyNativeEpochDirectories(reference.images)
  fact((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() === reference.bootId)
  await verifyNativeImage(reference.images.image, reference.images.imageIdentity)
  const operation = await openHelper(reference.images)
  let packetSent = false
  try {
    const nonce = randomBytes(32).toString('hex')
    const fields = ['control', String(reference.custodianPid), reference.custodianBirth,
      reference.images.helperIdentity.dev, reference.images.helperIdentity.ino, reference.epoch, nonce, action]
    if (action === 'peer') {
      fact(Number.isSafeInteger(clientPort) && clientPort! > 0 && clientPort! <= 65535)
      fields.push(String(clientPort), new URL(reference.baseUrl).port)
    }
    const packet = frame(fields)
    operation.assertLive(); packetSent = true; operation.child.stdin!.end(packet)
    const response = await operation.stream.next(`control-${action}`)
    fact(response.epoch === reference.epoch && response.nonce === nonce && response.pid === reference.nativePid &&
      response.birth === reference.nativeBirth && response.ok === true)
  } catch (error) {
    if (!packetSent && !await operation.closeUnadmitted()) throw new Error(HELPER_CLEANUP_UNCONFIRMED)
    throw error
  } finally { operation.child.stdin?.end() }
}

function bind(reference: NativeCustodyReference, child: ChildProcess | null): NativeCustody {
  const custody: NativeCustody = Object.freeze({ reference, child,
    stdout: privateNativeOutput(child?.stdio[3] as Readable | null ?? null, reference.authorization),
    stderr: privateNativeOutput(child?.stdio[4] as Readable | null ?? null, reference.authorization),
    verify: () => control(reference, 'inspect'),
    verifyPeer: (clientPort: number) => control(reference, 'peer', clientPort),
    stopExact: async () => withNativeAuthorityGate(authorityFile(reference), async () => {
      const authority = await readNativeAuthority(authorityFile(reference))
      fact(JSON.stringify(authority.reference) === JSON.stringify(reference))
      if (await nativeExitConfirmed(authority)) {
        await writeNativeAuthority(authorityFile(reference), { ...authority, phase: 'dead' })
        if (byEndpoint.get(reference.baseUrl) === custody) byEndpoint.delete(reference.baseUrl)
        return
      }
      await verifyAuthority(reference)
      await writeNativeAuthority(authorityFile(reference), { ...authority, phase: 'stopping' })
      try {
        await control(reference, 'stop')
        await writeNativeAuthority(authorityFile(reference), { ...authority, phase: 'dead' })
        if (byEndpoint.get(reference.baseUrl) === custody) byEndpoint.delete(reference.baseUrl)
      } catch (error) {
        if (await nativeExitConfirmed(authority)) {
          await writeNativeAuthority(authorityFile(reference), { ...authority, phase: 'dead' })
          if (byEndpoint.get(reference.baseUrl) === custody) byEndpoint.delete(reference.baseUrl)
          return
        }
        await writeNativeAuthority(authorityFile(reference), { ...authority, phase: 'unknown' }); throw error
      }
    }),
  })
  admitted.add(custody); byEndpoint.set(reference.baseUrl, custody)
  if (child) byChild.set(child, custody)
  return custody
}

export function nativeCustodyForEndpoint(baseUrl: string): NativeCustody {
  const custody = byEndpoint.get(baseUrl)
  fact(custody && admitted.has(custody)); return custody
}
export function nativeCustodyForChild(child: ChildProcess): NativeCustody | undefined { return byChild.get(child) }

export async function launchNativeCustody(input: {
  helper: Readonly<{ path: string; sha256: string }>; selectedBinary: string; profileRoot: string; hostKey: string; scope: unknown
  cwd: string; baseUrl: string; args: string[]; env: NodeJS.ProcessEnv; persistent: boolean
  minimumVersion: '1.16.0' | '1.18.0'
  signal?: AbortSignal
}): Promise<NativeCustody> {
  fact(process.platform === 'linux' && /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(input.baseUrl))
  input.signal?.throwIfAborted()
  const images = await createNativeEpochImages(input.profileRoot, input.hostKey, input.selectedBinary, input.helper.path)
  fact(images.helperIdentity.sha256 === input.helper.sha256)
  input.signal?.throwIfAborted()
  const file = nativeAuthorityPath(input.profileRoot, input.hostKey)
  return withNativeAuthorityGate(file, async () => {
    let previous: NativeAuthority | null = null
    try { previous = await readNativeAuthority(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (previous && previous.phase !== 'dead' && await nativeExitConfirmed(previous)) {
      previous = { ...previous, phase: 'dead' }; await writeNativeAuthority(file, previous)
    }
    fact(!previous || previous.phase === 'dead')
    const password = randomBytes(32).toString('hex')
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    const nativeEnvironment = { ...input.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' }
    const scope = { prepared: input.scope, args: input.args, environment: nativeEnvironment,
      workingDirectory: await realpath(input.cwd), minimumVersion: input.minimumVersion }
    const scopeDigest = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    let authority: NativeAuthority = { schemaVersion: 1, phase: 'preparing', profileRoot: input.profileRoot,
      hostKeyHash: path.basename(path.dirname(file)), scopeDigest, scope, images, reference: null }
    await writeNativeAuthority(file, authority, !previous)
    let operation: Awaited<ReturnType<typeof openHelper>> | undefined
    let creationSent = false
    try {
    // A probe owns a captured native creation too; uncertain closure blocks a
    // replacement even though no main-profile credentials have been sent.
    const measuredVersion = await measurePrivateImage(images, input.minimumVersion,
      { created: () => { creationSent = true }, closed: () => { creationSent = false } }, input.signal)
    operation = await openHelper(images, true)
    input.signal?.throwIfAborted()
    const args = [images.image, ...input.args]
    const env = Object.entries(nativeEnvironment).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => {
      fact(!key.includes('=') && key.length > 0); return `${key}=${value}`
    })
    const packet = frame(['launch', images.epoch, images.image, await realpath(input.cwd),
      input.persistent ? 'persistent' : 'ephemeral', images.imageIdentity.dev, images.imageIdentity.ino,
      String(args.length), ...args, String(env.length), ...env])
    input.signal?.throwIfAborted(); operation.assertLive(); creationSent = true
    operation.child.stdin!.write(packet)
    const started = await operation.stream.next('launch-started')
    fact(Number.isSafeInteger(started.pid) && Number(started.pid) > 0 && decimal(started.birth) &&
      started.custodianPid === operation.child.pid && started.custodianBirth === operation.hello.birth)
    const reference: NativeCustodyReference = Object.freeze({ schemaVersion: 1, platform: 'linux', epoch: images.epoch,
      baseUrl: input.baseUrl, bootId: operation.hello.bootId as string, nativePid: started.pid as number,
      nativeBirth: started.birth, custodianPid: started.custodianPid as number,
      custodianBirth: started.custodianBirth as string, images, profileRoot: input.profileRoot, scopeDigest, authorization, measuredVersion })
    authority = { ...authority, phase: 'published', reference }
    await writeNativeAuthority(file, authority)
    const custody = bind(reference, operation.child)
    return custody
  } catch (error) {
    // EOF cleans only an ephemeral captured creation. Persistent uncertainty is
    // retained; no PID-based fallback or replacement is allowed.
    let uncertain = creationSent || cleanupUnconfirmed(error)
    if (operation && !creationSent && !await operation.closeUnadmitted()) uncertain = true
    operation?.child.stdin?.end()
    await writeNativeAuthority(file, { ...authority, phase: uncertain ? 'unknown' : 'dead' })
    if (uncertain && !creationSent) throw new Error(HELPER_CLEANUP_UNCONFIRMED)
    throw error
  }
  })
}

export async function recoverNativeCustody(profileRoot: string, hostKey: string, expectedBaseUrl: string): Promise<NativeCustody> {
  const authority = await readNativeAuthority(nativeAuthorityPath(profileRoot, hostKey))
  const reference = authority.reference
  fact(reference && reference.schemaVersion === 1 && reference.platform === 'linux' && reference.epoch === reference.images.epoch &&
    reference.profileRoot === profileRoot && reference.baseUrl === expectedBaseUrl &&
    Number.isSafeInteger(reference.nativePid) && reference.nativePid > 0 && decimal(reference.nativeBirth) &&
    Number.isSafeInteger(reference.custodianPid) && reference.custodianPid > 0 && decimal(reference.custodianBirth) &&
    typeof reference.bootId === 'string' && /^[a-f0-9-]{36}$/.test(reference.bootId) &&
    typeof reference.authorization === 'string' && /^Basic [A-Za-z0-9+/=]{32,1024}$/.test(reference.authorization) &&
    typeof reference.measuredVersion === 'string' && reference.measuredVersion.startsWith('1.') &&
    (compareOpenCodeNativeVersions(reference.measuredVersion, '1.16.0') ?? -1) >= 0)
  await control(reference, 'inspect')
  return bind(Object.freeze(reference), null)
}

// Only HostManager/native admission can bind a physical epoch to a local owner.
const requestOwners = new OpenCodeNativeRequestOwners<NativeCustody>(
  custody => fact(admitted.has(custody)),
  (first, second) => JSON.stringify(first.reference) === JSON.stringify(second.reference),
)
export function bindNativeRequestOwner<T extends object>(owner: T, custody: NativeCustody): T {
  return requestOwners.bind(owner, custody)
}
export function inheritNativeRequestOwner<T extends object>(owner: T, source: object): T {
  return requestOwners.inherit(owner, source)
}
export function hasNativeRequestOwner(owner: object): boolean { return requestOwners.has(owner) }
export function nativeCustodyForRequest(owner: object | undefined, baseUrl: string): NativeCustody {
  const custody = requestOwners.capture(owner)
  fact(custody.reference.baseUrl === baseUrl)
  return custody
}
export async function recheckNativeRequestAuthority(custody: NativeCustody): Promise<void> {
  fact(admitted.has(custody))
  // Recheck the captured reference, never whichever epoch now occupies its URL.
  await verifyAuthority(custody.reference)
}

export async function resolveNativeCustodyHelper(): Promise<Readonly<{ path: string; sha256: string }>> {
  const explicit = process.env.CLAUDE_MULTIMODEL_OPENCODE_CUSTODY_HELPER?.trim()
  const root = path.dirname(process.execPath)
  const suffix = path.join('native', 'opencode-custody', `linux-${process.arch}`, 'custodian')
  const candidates = explicit ? [explicit] : [path.join(root, suffix), path.join(root, '..', suffix),
    path.resolve(import.meta.dir, '../../../../dist', suffix), path.resolve(import.meta.dir, '..', suffix)]
  let selected: string | undefined
  for (const candidate of candidates) {
    try { await lstat(candidate); selected = candidate; break }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  fact(selected)
  fact(path.isAbsolute(selected) && await realpath(selected) === selected)
  const metadata = await lstat(selected)
  fact(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0 && !(metadata.mode & 0o022))
  let manifest: Record<string, unknown>
  try { manifest = record(JSON.parse(await readFile(`${selected}.json`, 'utf8'))) }
  catch { throw new Error('native_custody_asset_unavailable') }
  fact(manifest.schemaVersion === 1 && manifest.platform === 'linux' && manifest.arch === process.arch &&
    manifest.size === metadata.size && typeof manifest.sha256 === 'string' && /^[a-f0-9]{64}$/.test(manifest.sha256))
  return Object.freeze({ path: selected, sha256: manifest.sha256 })
}

export type { NativeCustody, NativeFileIdentity }
