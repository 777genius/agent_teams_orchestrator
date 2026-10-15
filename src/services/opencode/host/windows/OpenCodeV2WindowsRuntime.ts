import { openCodeBunVersion } from '../../../../constants/openCodeBunVersion.js'
import { createServer } from 'node:http'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OpenCodeV2Pin } from '../../compatibility/OpenCodeGenerationPolicy.js'
import { verifyOpenCodePackage, verifyOpenCodeV2ServerGraph } from '../OpenCodeV2ServerGraph.js'
import type { ServerOptions as FloorOptions } from '@opencode/server-v2-floor/options'
import type { ServerOptions as CurrentOptions } from '@opencode/server/options'
import { isWindowsCommandPort, type WindowsCommandPort } from './OpenCodeV2WindowsCommand.js'
import type { OwnedNativeProfile } from '../OpenCodeV2ExecutionBinding.js'

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error('execution_windows_runtime_invalid')
}
const OUTPUT_LIMIT = 8 * 1024 * 1024
const CONTROL_ENV = /^OPENCODE_V2_/i

/** Child-local official routes with the documented spawner replacement.
 * Does not open Windows admission or imply parent loopback reachability.
 * Environment comes from the private child composition, not an ambient merge. */
export async function loadOpenCodeV2WindowsRuntime(pin: OpenCodeV2Pin, expectedModuleSha256: string,
  commands: WindowsCommandPort, profile: OwnedNativeProfile) {
  requireValue(process.platform === 'win32' && process.versions.bun === openCodeBunVersion())
  requireValue(pin === '2.0.0' || pin === '2.0.21')
  requireValue(isWindowsCommandPort(commands))
  const trustedEnvironment = Object.freeze({ ...profile.env })
  const databasePath = profile.databasePath, configDirectory = profile.config.directory
  const data = path.dirname(databasePath), cache = path.join(trustedEnvironment.XDG_CACHE_HOME!, 'opencode')
  const globalPaths = Object.freeze({ home: trustedEnvironment.HOME!, data, cache, config: configDirectory,
    state: path.join(trustedEnvironment.XDG_STATE_HOME!, 'opencode'), tmp: trustedEnvironment.TMPDIR!,
    bin: path.join(cache, 'bin'), log: path.join(data, 'log'), repos: path.join(data, 'repos') })
  requireValue(path.isAbsolute(profile.root) && Object.values(globalPaths).every(value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return false
    const relative = path.relative(profile.root, value)
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }) && trustedEnvironment.TEMP === globalPaths.tmp && trustedEnvironment.TMP === globalPaths.tmp)
  const graph = await verifyOpenCodeV2ServerGraph(pin)
  requireValue(graph.moduleSha256 === expectedModuleSha256)
  const directory = path.dirname(graph.modulePath)
  async function load<T>(specifier: string, packageName: string, version: string): Promise<T> {
    const entry = await realpath(Bun.resolveSync(specifier, directory))
    await verifyOpenCodePackage(entry, packageName, version)
    return import(pathToFileURL(entry).href) as Promise<T>
  }
  // No Effect values from a different physical graph enter this layer.
  const effect: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
  const spawn = await load<typeof import('effect/unstable/process/ChildProcessSpawner')>(
    'effect/unstable/process/ChildProcessSpawner', 'effect', '4.0.0-rc.112')
  const httpTypes = await load<typeof import('effect/unstable/http')>('effect/unstable/http', 'effect', '4.0.0-rc.112')
  const routes = await load<typeof import('@opencode/server/routes')>('@opencode/server/routes', '@opencode/server', pin)
  const cross = await load<typeof import('@opencode/util/cross-spawn-spawner')>(
    '@opencode/util/cross-spawn-spawner', '@opencode/util', pin)
  const global = await load<typeof import('@opencode/util/global')>('@opencode/util/global', '@opencode/util', pin)
  const http = await load<typeof import('@effect/platform-node/NodeHttpServer')>(
    '@effect/platform-node/NodeHttpServer', '@effect/platform-node', '4.0.0-rc.112')
  const { Effect, Layer, PlatformError, Stream, Sink, Scope, Exit, Context } = effect
  const error = (method: string) => PlatformError.systemError({
    _tag: 'Unknown', module: 'ChildProcess', method, description: 'Windows owned command operation failed',
  })
  const attempt = <A>(method: string, action: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({ try: action, catch: () => error(method) })

  function commandEnvironment(extra?: Record<string, string | undefined>, extend?: boolean) {
    const result: Record<string, string> = {}
    const names = new Map<string, string>()
    const insert = (name: string, value: string | undefined) => {
      requireValue(name.length > 0 && !/[=\0]/.test(name))
      // Official Shell passes its full child environment as an explicit env.
      // Control capabilities never propagate, including from that projection.
      if (CONTROL_ENV.test(name)) return
      const previous = names.get(name.toUpperCase())
      if (previous) delete result[previous]
      names.set(name.toUpperCase(), name)
      if (value !== undefined) { requireValue(!value.includes('\0')); result[name] = value }
    }
    if (!extra || extend) for (const [name, value] of Object.entries(trustedEnvironment)) insert(name, value)
    for (const [name, value] of Object.entries(extra ?? {})) insert(name, value)
    return result
  }
  const baseline = Object.freeze(commandEnvironment())
  const baselineValue = (name: string) => Object.entries(baseline).find(([key]) => key.toUpperCase() === name)?.[1]
  requireValue(path.isAbsolute(baselineValue('SYSTEMROOT') ?? baselineValue('WINDIR') ?? '') &&
    (baselineValue('PATH') ?? '').split(';').some(value => path.isAbsolute(value)))
  const spawner = spawn.make(command => Effect.gen(function* () {
    if (command._tag !== 'StandardCommand') return yield* Effect.fail(error('unsupportedCommand'))
    const stdinOption = command.options.stdin
    // Both published MCP graphs use precisely this scoped byte stream with
    // EOF on completion. Other stdin configurations remain unsupported.
    const streamInput = stdinOption && typeof stdinOption === 'object' && 'stream' in stdinOption &&
      Stream.isStream(stdinOption.stream) && stdinOption.endOnDone === true &&
      (stdinOption.encoding === undefined || stdinOption.encoding === 'utf8') ? stdinOption.stream : undefined
    if (command.options.additionalFds !== undefined || command.options.shell || command.options.detached ||
      (stdinOption !== 'ignore' && !streamInput) ||
      [command.options.stdout, command.options.stderr].some(value => value !== undefined && value !== 'pipe')) {
      return yield* Effect.fail(error('unsupportedCommand'))
    }
    const input = yield* attempt('resolve', async () => {
      const env = command.options.env ? commandEnvironment(command.options.env, command.options.extendEnv) : { ...baseline }
      const cwd = await realpath(command.options.cwd ?? process.cwd())
      requireValue(path.isAbsolute(cwd) && (await stat(cwd)).isDirectory())
      requireValue(command.command.length > 0 && !command.command.includes('\0') && command.args.every(arg => !arg.includes('\0')))
      let executable: string | undefined
      if (path.isAbsolute(command.command)) executable = await realpath(command.command)
      else {
        // Only ordinary PATH names; never search the current directory or use
        // cmd.exe AutoRun/shell resolution as a substitute for an executable.
        requireValue(!/[\\/]/.test(command.command))
        const search = Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? ''
        for (const root of search.split(';').filter(value => path.isAbsolute(value))) {
          const candidate = path.join(root, command.command + (path.extname(command.command) ? '' : '.exe'))
          try { if ((await stat(candidate)).isFile()) { executable = await realpath(candidate); break } }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
        }
      }
      requireValue(executable && (await stat(executable)).isFile())
      // The native port serializes this cmd tail using cmd's outer quote pair,
      // rather than CRT argv quoting. /d disables host AutoRun registry hooks.
      const args = path.basename(executable).toLowerCase() === 'cmd.exe' && command.args.length === 2 &&
        command.args[0]?.toLowerCase() === '/c' ? ['/d', '/s', '/c', command.args[1]!] : command.args
      return { executable, args, cwd, env, stdin: streamInput ? 'pipe' as const : 'ignore' as const }
    })
    let retired: Promise<void> | undefined
    const owned = yield* Effect.acquireRelease(attempt('spawn', signal => commands.start(input, signal)), value =>
      attempt('close', async () => { await retire(value.commandId); await commands.close({ commandId: value.commandId }) }).pipe(Effect.orDie))
    function retire(commandId: string) {
      return retired ??= (async () => {
        const result = await commands.retire({ commandId })
        requireValue(result.empty === true && result.activeProcesses === 0 && result.heldProcessExited === true)
      })()
    }
    // A malformed receipt still belongs to acquireRelease and is retired.
    yield* attempt('identity', async () => {
      requireValue(owned.commandId.length > 0 && Number.isSafeInteger(owned.pid) && owned.pid > 0 && /^[1-9]\d{0,19}$/.test(owned.birthFiletime))
    })
    const status = () => attempt('status', async signal => {
      const value = await commands.status({ commandId: owned.commandId }, signal)
      requireValue(typeof value.running === 'boolean' && (value.running ? value.exitCode === null : Number.isInteger(value.exitCode)))
      return value
    })
    const exitCode = Effect.gen(function* () {
      for (;;) { const value = yield* status(); if (!value.running) return spawn.ExitCode(value.exitCode!); yield* Effect.sleep(10) }
    })
    let stdinOffset = 0
    const stdinSink = Sink.forEach((chunk: Uint8Array) => attempt('writeStdin', async signal => {
      requireValue(chunk instanceof Uint8Array && stdinOffset + chunk.byteLength <= 64 * 1024 * 1024)
      let position = 0
      while (position < chunk.byteLength) {
        const bytes = Buffer.from(chunk.subarray(position, position + 8192))
        const acknowledged = await commands.writeStdin({ commandId: owned.commandId, offset: stdinOffset,
          bytesBase64: bytes.toString('base64') }, signal)
        requireValue(Number.isSafeInteger(acknowledged.writtenBytes) && acknowledged.writtenBytes > 0 &&
          acknowledged.writtenBytes <= bytes.length && acknowledged.nextOffset === stdinOffset + acknowledged.writtenBytes)
        stdinOffset = acknowledged.nextOffset; position += acknowledged.writtenBytes
      }
    }))
    if (streamInput) {
      yield* Effect.forkScoped(Stream.run(streamInput, stdinSink).pipe(
        Effect.andThen(attempt('endStdin', async signal => {
          const acknowledged = await commands.endStdin({ commandId: owned.commandId, offset: stdinOffset }, signal)
          requireValue(acknowledged.closed === true && acknowledged.nextOffset === stdinOffset)
        })),
        Effect.onError(() => attempt('retire', () => retire(owned.commandId)).pipe(Effect.orDie)),
      ))
    }
    const output = (stream: 'stdout' | 'stderr') => Stream.unfold({ offset: 0, done: false }, state =>
      Effect.gen(function* () {
        if (state.done) return undefined
        for (;;) {
          const value = yield* attempt('readOutput', signal => commands.read({ commandId: owned.commandId, stream, offset: state.offset, maxBytes: 8192 }, signal))
          const bytes = yield* attempt('validateOutput', async () => {
            const result = Buffer.from(value.bytesBase64, 'base64')
            requireValue(result.toString('base64') === value.bytesBase64 && result.length <= 8192 &&
              value.nextOffset === state.offset + result.length && typeof value.eof === 'boolean')
            if (value.nextOffset > OUTPUT_LIMIT) { await retire(owned.commandId); throw error('outputLimit') }
            return new Uint8Array(result)
          })
          if (bytes.length) return [bytes, { offset: value.nextOffset, done: value.eof }] as const
          if (value.eof) return undefined
          yield* Effect.sleep(10)
        }
      }))
    const stdout = output('stdout'), stderr = output('stderr')
    return spawn.makeHandle({
      // The supplied MCP stream is already the sole scoped writer; exposing a
      // second writer would race offsets and weaken stdin ownership.
      pid: spawn.ProcessId(owned.pid), stdin: streamInput ? Sink.fail(error('stdinAlreadyBound')) : Sink.drain, stdout, stderr,
      all: Stream.mergeAll([stdout, stderr], { concurrency: 2 }), exitCode,
      isRunning: status().pipe(Effect.map(value => value.running)),
      kill: options => options?.killSignal && !['SIGTERM', 'SIGKILL'].includes(options.killSignal)
        ? Effect.fail(error('unsupportedSignal')) : attempt('kill', () => retire(owned.commandId)),
      getInputFd: () => Sink.fail(error('unsupportedDescriptor')),
      getOutputFd: () => Stream.fail(error('unsupportedDescriptor')),
      unref: Effect.fail(error('unsupportedUnref')),
    })
  }))
  function createRoutes(options: FloorOptions & CurrentOptions, urls: () => readonly string[]) {
    requireValue(typeof options.password === 'string' && options.password.length === 43 && !options.simulation &&
      options.database?.path === databasePath && options.config?.directory === configDirectory)
    return routes.createRoutes(options, urls, [cross.node.replace(Layer.succeed(spawn.ChildProcessSpawner, spawner)),
      global.node.replace(global.layerWith(globalPaths))])
  }
  async function start(options: FloorOptions & CurrentOptions, signal?: AbortSignal) {
    requireValue(typeof options.password === 'string' && options.password.length === 43 && !options.simulation)
    signal?.throwIfAborted()
    const scope = await Effect.runPromise(Scope.make())
    let closing: Promise<void> | undefined
    const close = () => closing ??= Effect.runPromise(Scope.close(scope, Exit.void))
    try {
      const baseUrl = await Effect.runPromise(Effect.gen(function* () {
        const node = createServer()
        // Registered after NodeHttpServer's finalizer: LIFO destroys open SSE
        // connections before awaiting the listener's close callback.
        const server = yield* http.make(() => node, { host: '127.0.0.1', port: 0, gracefulShutdownTimeout: '2 seconds' })
        yield* Effect.addFinalizer(() => Effect.sync(() => node.closeAllConnections()))
        requireValue(server.address._tag === 'TcpAddress' && server.address.hostname === '127.0.0.1')
        const address = server.address
        requireValue(address._tag === 'TcpAddress')
        const url = `http://127.0.0.1:${address.port}`
        const services = yield* Layer.build(createRoutes({ ...options, hostname: '127.0.0.1', port: 0 }, () => [url])
          .pipe(Layer.provideMerge(http.layerHttpServices)))
        const handler = Context.get(services, httpTypes.HttpRouter.HttpRouter).asHttpEffect().pipe(Effect.provide(services))
        yield* server.serve(handler).pipe(Effect.provide(http.layerHttpServices))
        return url
      }).pipe(Effect.provideService(Scope.Scope, scope)), { signal })
      signal?.throwIfAborted()
      // URL is child-local. Parent must use the authenticated bounded streaming
      // transport; returning it never qualifies direct loopback access.
      return Object.freeze({ baseUrl, close, reachability: 'child-self-http-only' as const })
    } catch (cause) {
      try { await close() } catch (cleanup) { throw new AggregateError([cause, cleanup], 'execution_cleanup_unknown') }
      throw cause
    }
  }
  return Object.freeze({ createRoutes, start })
}
