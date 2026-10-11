import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { Effect, Layer, PlatformError, Sink, Stream } from 'effect'
import { ChildProcessSpawner, ExitCode, ProcessId, make, makeHandle } from 'effect/unstable/process/ChildProcessSpawner'
import { launchNativeCommand } from './native-command.ts'

const error = (method: string, cause: unknown) => PlatformError.systemError({ _tag: 'Unknown', module: 'ChildProcess', method, description: String(cause), cause })
const attempt = <A>(method: string, action: () => Promise<A>) => Effect.tryPromise({ try: action, catch: cause => error(method, cause) })
export type CommandReceipt = { pid: number; birthFiletime: string; assignedBeforeResume: boolean; exactOuterJob: boolean; activeBeforeCancel?: number; activeAfterClose?: number; heldExited?: boolean; closed: boolean }

export function commandLayer(directory: string, receipts: CommandReceipt[]) {
  const spawner = make(command => Effect.gen(function* () {
    if (command._tag !== 'StandardCommand' || command.options.additionalFds || command.options.shell || (command.options.stdin !== undefined && command.options.stdin !== 'ignore')) return yield* Effect.fail(error('spawn', 'TEST supports standard commands with ignored stdin only'))
    const cwd = command.options.cwd ?? process.cwd()
    const environment = Object.fromEntries(Object.entries(command.options.env && !command.options.extendEnv ? command.options.env : { ...process.env, ...command.options.env }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    const executable = yield* attempt('resolve', async () => {
      if (path.isAbsolute(command.command)) return command.command
      for (const root of (environment.PATH ?? environment.Path ?? '').split(';')) {
        for (const suffix of path.extname(command.command) ? [''] : ['.exe']) {
          const candidate = path.join(root, command.command + suffix)
          if (await stat(candidate).then(info => info.isFile()).catch(() => false)) return candidate
        }
      }
      throw new Error(`TEST executable unavailable: ${command.command}`)
    })
    const files = yield* attempt('stdio', async () => {
      const root = path.join(directory, randomUUID()); await mkdir(root, { recursive: true })
      const stdinPath = path.join(root, 'stdin.empty'), stdoutPath = path.join(root, 'stdout.txt'), stderrPath = path.join(root, 'stderr.txt')
      await writeFile(stdinPath, ''); return { stdinPath, stdoutPath, stderrPath }
    })
    const native = yield* Effect.acquireRelease(
      Effect.try({ try: () => launchNativeCommand({ executable, args: command.args, cwd, env: environment, ...files }), catch: cause => error('spawn', cause) }),
      value => Effect.sync(() => {
        const receipt = receipts.find(item => item.pid === value.pid && item.birthFiletime === value.birthFiletime)
        value.close()
        if (receipt) { receipt.closed = true; receipt.activeAfterClose = 0; receipt.heldExited = true }
      }),
    )
    const receipt: CommandReceipt = { pid: native.pid, birthFiletime: native.birthFiletime, assignedBeforeResume: native.assignedBeforeResume, exactOuterJob: native.exactOuterJob, closed: false }; receipts.push(receipt)
    const output = (file: string) => Stream.unfold(0, offset => attempt('readOutput', async () => {
      for (;;) {
        if ((await stat(file)).size > 8 * 1024 * 1024) { native.terminate(); throw new Error('TEST command output exceeds owned stream bound') }
        const fileHandle = await open(file, 'r')
        const buffer = Buffer.alloc(8192)
        let count: number
        try { count = (await fileHandle.read(buffer, 0, buffer.length, offset)).bytesRead } finally { await fileHandle.close() }
        if (count) return [new Uint8Array(buffer.subarray(0, count)), offset + count] as const
        if (native.exited()) return undefined
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }))
    const stdout = output(files.stdoutPath), stderr = output(files.stderrPath)
    const exitCode = Effect.gen(function* () { while (!native.exited()) yield* Effect.sleep(10); return ExitCode(native.exitCode()) })
    return makeHandle({
      pid: ProcessId(native.pid), stdout, stderr, all: Stream.mergeAll([stdout, stderr], { concurrency: 2 }),
      stdin: Sink.drain, exitCode, isRunning: Effect.sync(() => !native.exited()),
      kill: () => Effect.try({ try: () => { receipt.activeBeforeCancel = native.active(); native.terminate() }, catch: cause => error('kill', cause) }).pipe(Effect.andThen(exitCode), Effect.asVoid),
      getInputFd: () => Sink.fail(error('inputFd', 'TEST extra descriptors unsupported')),
      getOutputFd: () => Stream.fail(error('outputFd', 'TEST extra descriptors unsupported')),
      unref: Effect.succeed(Effect.void),
    })
  }))
  return Layer.succeed(ChildProcessSpawner, spawner)
}
