import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function assert(value: unknown, code: string): asserts value { if (!value) throw new Error(code) }
export type WindowsNativeArtifact = Readonly<{ path: string; sha256: string; arch: 'x64' | 'arm64' }>
const artifacts = new WeakSet<WindowsNativeArtifact>()
const CONTROL_PACKET_LIMIT = 16 * 1024 * 1024
const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
/** One sealed native producer artifact. End users never compile or download it. */
export async function resolveWindowsNativeArtifact(): Promise<WindowsNativeArtifact> {
  assert(process.platform === 'win32' && ['x64', 'arm64'].includes(process.arch), 'execution_containment_platform_pending')
  const location = fileURLToPath(import.meta.url)
  assert(!location.includes('$bunfs') && !location.includes('~BUN'), 'v2_compiled_runtime_unsupported')
  const marker = `${path.sep}src${path.sep}`
  const root = location.includes(marker) ? location.slice(0, location.lastIndexOf(marker)) : path.dirname(location)
  const directory = path.join(await realpath(root), 'native', `win32-${process.arch}`)
  const executable = path.join(directory, 'opencode-v2-windows-helper.exe')
  const manifest: unknown = JSON.parse(await readFile(path.join(directory, 'windows-helper.json'), 'utf8'))
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'execution_containment_helper_identity')
  const value = manifest as Record<string, unknown>
  assert(value.format === 1 && value.platform === 'win32' && value.arch === process.arch && value.name === 'opencode-v2-windows-helper.exe' && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'execution_containment_helper_identity')
  const info = await lstat(executable)
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && await realpath(executable) === executable && await hash(executable) === value.sha256, 'execution_containment_helper_identity')
  const artifact = Object.freeze({ path: executable, sha256: value.sha256, arch: process.arch as 'x64' | 'arm64' })
  artifacts.add(artifact); return artifact
}
export type WindowsNativeBroker = Readonly<{
  events: EventEmitter; request(operation: string, input?: Readonly<Record<string, unknown>>, deadline?: number, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>; ended(): boolean
}>
/** The native process owns every HANDLE. EOF/crash closes the only outer Job
 * reference; no HANDLE values are serialized or inherited by user commands. */
export function createWindowsNativeBroker(artifact: WindowsNativeArtifact): WindowsNativeBroker {
  assert(artifacts.has(artifact), 'execution_containment_helper_identity')
  const events = new EventEmitter(), pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; dispose(): void }>()
  const child = spawn(artifact.path, ['--broker'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } })
  let ended = false, sequence = 0, buffer = '', stderr = ''
  const decoder = new StringDecoder('utf8')
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  const fail = (error: Error) => { for (const waiter of pending.values()) { waiter.dispose(); waiter.reject(error) }; pending.clear() }
  child.on('error', error => { ended = true; fail(new Error('execution_containment_helper_failed', { cause: error })); events.emit('error', error) })
  child.once('close', code => { ended = true; fail(new Error('execution_containment_helper_closed')); resolveExit(); events.emit('close', code) })
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16384) })
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    if (Buffer.byteLength(buffer) > CONTROL_PACKET_LIMIT) { fail(new Error('execution_invalid_response')); child.stdin.end(); return }
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        assert(value && typeof value === 'object' && !Array.isArray(value) && value.schema === 1, 'execution_invalid_response')
        if (value.kind === 'reply') {
          const waiter = pending.get(Number(value.id)); assert(waiter, 'execution_invalid_response'); pending.delete(Number(value.id)); waiter.dispose()
          if (value.ok === true) waiter.resolve(value.value)
          else {
            const code = typeof value.error === 'string' && /^[a-z_]{1,96}$/.test(value.error) ? value.error : 'execution_native_unknown'
            const context = typeof value.stage === 'string' && /^[a-z_]{1,64}$/.test(value.stage) && Number.isSafeInteger(value.nativeCode) && Number(value.nativeCode) >= 0 && Number(value.nativeCode) <= 0xffffffff ? `:${value.stage}:${value.nativeCode}` : ''
            waiter.reject(new Error(code + context))
          }
        } else if (value.kind === 'event' && typeof value.event === 'string') events.emit(value.event, value.value)
        else throw new Error('execution_invalid_response')
      } catch (error) { fail(new Error('execution_invalid_response', { cause: error })); child.stdin.end() }
    }
  })
  return Object.freeze({ events, ended: () => ended,
    request(operation: string, input: Readonly<Record<string, unknown>> = {}, deadline = Date.now() + 15000, signal?: AbortSignal) {
      assert(!ended && /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(operation) && deadline > Date.now(), 'execution_native_unknown')
      signal?.throwIfAborted()
      const id = ++sequence, bytes = JSON.stringify({ schema: 1, id, operation, input }) + '\n'
      assert(Buffer.byteLength(bytes) <= CONTROL_PACKET_LIMIT, 'execution_invalid_response')
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); dispose(); reject(new Error('execution_native_timeout')); child.stdin.end() }, deadline - Date.now())
        const abort = () => { pending.delete(id); dispose(); reject(new Error('execution_cancelled')); child.stdin.end() }
        const dispose = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
        pending.set(id, { resolve, reject, dispose }); signal?.addEventListener('abort', abort, { once: true })
        child.stdin.write(bytes, error => { if (error) { pending.delete(id); dispose(); reject(new Error('execution_native_unknown')); child.stdin.end() } })
        if (signal?.aborted) abort()
      })
    },
    async close() {
      child.stdin.end()
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup_unknown')), 15000) })]) }
      finally { clearTimeout(timer) }
      assert(ended, 'cleanup_unknown'); void stderr
    },
  })
}
