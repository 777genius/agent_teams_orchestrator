import { expect, test } from 'bun:test'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { verifyOpenCodePackage, verifyOpenCodeV2GraphEffect, verifyOpenCodeV2ServerGraph } from '../../src/services/opencode/host/OpenCodeV2ServerGraph.js'
import { readShellProbeResult, createShellProbeConfig, shellProbeFailure, shellProbeSetupFailure, type ShellProbeResult } from './windows-shell-tool-contract.js'

test('the exact no-model document decodes with the verified selected config schema', async () => {
  const graph = await verifyOpenCodeV2ServerGraph('2.0.32')
  const entry = await realpath(Bun.resolveSync('@opencode/schema/config', path.dirname(graph.modulePath)))
  await verifyOpenCodePackage(entry, '@opencode/schema', '2.0.32')
  await verifyOpenCodeV2GraphEffect(entry, graph.effectPath, '2.0.32')
  const { Schema }: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
  const { Config }: typeof import('@opencode/schema/config') = await import(pathToFileURL(entry).href)
  const controllerRoot = 'C:\\TEST\\TEST-claude', bun = 'C:\\TEST\\bun.exe'
  const config = createShellProbeConfig(controllerRoot, bun)
  const decoded = Schema.decodeUnknownSync(Config.Info)(config)
  expect(decoded.default_agent).toBe('TEST-shell-agent')
  expect(decoded.agents?.['TEST-shell-agent']?.permissions).toEqual(config.agents['TEST-shell-agent'].permissions)
  const controller = decoded.mcp?.servers?.['agent-teams']
  expect(controller?.type).toBe('local'); expect(controller?.disabled).toBe(true)
  if (controller?.type !== 'local') throw new Error('TEST_expected_local_controller')
  expect(controller.environment?.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe(controllerRoot)
  expect(controller.command).toEqual([bun, '--version'])
})

test('selected stable Effect failure retains only the adapter method through tool/process wrappers', async () => {
  const graph = await verifyOpenCodeV2ServerGraph('2.0.32')
  const { Effect, Exit, PlatformError }: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
  const original = PlatformError.systemError({ _tag: 'Unknown', module: 'ChildProcess', method: 'resolve',
    description: 'Windows owned command operation failed' })
  expect(original.message).toBe('Unknown: ChildProcess.resolve: Windows owned command operation failed')
  const wrapper = { _tag: 'ToolFailure', error: { _tag: 'AppProcessError', cause: original } }
  const exit = await Effect.runPromiseExit(Effect.fail(wrapper))
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error('TEST_expected_failure')
  expect(shellProbeFailure(exit.cause)).toEqual({ kind: 'Fail', method: 'resolve' })
  expect(exit.cause.reasons[0]).toMatchObject({ error: wrapper })
  const die = await Effect.runPromiseExit(Effect.die(original))
  if (!Exit.isFailure(die)) throw new Error('TEST_expected_defect')
  expect(shellProbeFailure(die.cause)).toEqual({ kind: 'Die', method: 'resolve' })
})

test('finite failure projector ignores other leaves, unknown methods, raw fields and accessors', () => {
  let reads = 0
  const hostile = Object.defineProperty({}, 'reason', { get() { reads++; throw new Error('TEST_getter') } })
  expect(shellProbeFailure({ reasons: [{ _tag: 'Fail', error: hostile }] })).toEqual({ kind: 'Fail', method: null })
  expect(reads).toBe(0)
  const later = { _tag: 'PlatformError', reason: { _tag: 'Unknown', module: 'ChildProcess', method: 'spawn',
    description: 'Windows owned command operation failed' } }
  expect(shellProbeFailure({ reasons: [{ _tag: 'Fail', error: {} }, { _tag: 'Fail', error: later }] }))
    .toEqual({ kind: 'Fail', method: null })
  expect(shellProbeFailure(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('TEST_proxy') } })))
    .toEqual({ kind: 'unknown', method: null })
  const cycle: { cause?: object } = {}; cycle.cause = cycle
  expect(shellProbeFailure({ reasons: [{ _tag: 'Fail', error: cycle }] })).toEqual({ kind: 'Fail', method: null })
})

test('child result admission strips extras and requires actual complete evidence for a positive', () => {
  const positive: ShellProbeResult = { stage: 'complete', succeeded: true, sessionCreated: true, registeredShell: true,
    shell: 'cmd', markerPresent: true, failure: null }
  expect(readShellProbeResult({ ...positive, command: 'TEST-private', output: 'TEST-private' })).toEqual(positive)
  expect(readShellProbeResult({ ...positive, markerPresent: false })).toBeUndefined()
  expect(readShellProbeResult({ ...positive, stage: 'tool-execute' })).toBeUndefined()
  expect(readShellProbeResult({ ...positive, failure: { kind: 'Fail', method: 'resolve' } })).toBeUndefined()
  expect(readShellProbeResult({ ...positive, shell: { toString() { throw new Error('TEST_coercion') } } })).toBeUndefined()
  expect(readShellProbeResult({ ...positive, failure: { kind: 'Fail', method: 'raw-method' }, succeeded: false })).toBeUndefined()
})


test('pregraph diagnostics retain only closed own-data guards and privately minted native facts', () => {
  const realpath = { status: 1, operation: 2, win32: 5, anchorCount: 2, matchingAnchorIndex: 0 }
  const original = Object.assign(new Error('TEST-private-path-and-message'), {
    profileGuard: 'process_environment', code: 'EPERM', syscall: 'realpath', realpath, path: 'TEST-private',
  })
  expect(shellProbeSetupFailure(original)).toEqual({ kind: 'unknown', method: null,
    profileGuard: 'process_environment', errno: 'EPERM', operation: 'realpath' })
  let reads = 0
  const hostile = Object.defineProperty({}, 'profileGuard', { get() { reads++; throw new Error('TEST_getter') } })
  expect(shellProbeSetupFailure(hostile)).toEqual({ kind: 'unknown', method: null })
  expect(reads).toBe(0)
  expect(shellProbeSetupFailure(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('TEST_proxy') } })))
    .toEqual({ kind: 'unknown', method: null })
  const result = { stage: 'profile-validation', succeeded: false, sessionCreated: false, registeredShell: false,
    shell: null, markerPresent: false, failure: { kind: 'unknown', method: null,
      profileGuard: 'home_mapping', errno: 'EPERM', operation: 'realpath', realpath, message: 'TEST-private' } }
  expect(readShellProbeResult(result)?.failure).toEqual({ kind: 'unknown', method: null,
    profileGuard: 'home_mapping', errno: 'EPERM', operation: 'realpath', realpath })
  for (const invalid of [{ ...realpath, matchingAnchorIndex: 2 }, { ...realpath, status: 0 }, { ...realpath, operation: 26 },
    { ...realpath, win32: 0x100000000 }, { ...realpath, anchorCount: 4097 }]) {
    expect(readShellProbeResult({ ...result, failure: { kind: 'unknown', method: null, realpath: invalid } })?.failure)
      .toEqual({ kind: 'unknown', method: null })
  }
})


test('instance defects keep one selected Cause leaf and the existing closed filesystem vocabulary', async () => {
  const graph = await verifyOpenCodeV2ServerGraph('2.0.32')
  const { Effect, Exit, PlatformError }: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
  const native = Object.assign(new Error('TEST-private-path'), { code: 'EPERM', path: 'TEST-private' })
  const error = PlatformError.systemError({ _tag: 'Unknown', module: 'FileSystem', method: 'realPath',
    pathOrDescriptor: 'TEST-private', cause: native })
  const exit = await Effect.runPromiseExit(Effect.die(error))
  if (!Exit.isFailure(exit)) throw new Error('TEST_expected_defect')
  const observed = shellProbeFailure(exit.cause)
  expect(observed).toEqual({ kind: 'Die', method: null, detail: { tag: 'PlatformError', module: 'FileSystem',
    method: 'realPath', reason: 'Unknown', errno: 'EPERM', name: 'Error' } })
  const result = { stage: 'instance', succeeded: false, sessionCreated: true, registeredShell: false,
    shell: null, markerPresent: false, failure: { ...observed, detail: { ...observed.detail,
      message: 'TEST-private', pathOrDescriptor: 'TEST-private' } } }
  expect(readShellProbeResult(result)?.failure).toEqual(observed)
  expect(shellProbeFailure({ reasons: [{ _tag: 'Interrupt' }, ...exit.cause.reasons] }))
    .toEqual({ kind: 'Interrupt', method: null })
  expect(shellProbeFailure({ reasons: [{ _tag: 'Die', defect: {} }, ...exit.cause.reasons] }))
    .toEqual({ kind: 'Die', method: null })
  expect(readShellProbeResult({ ...result, failure: { kind: 'Die', method: null, detail: { method: 'TEST-raw-method' } } })?.failure)
    .toEqual({ kind: 'Die', method: null })
  let reads = 0
  const hostile = Object.defineProperty({}, 'method', { get() { reads++; throw new Error('TEST_getter') } })
  expect(readShellProbeResult({ ...result, failure: { kind: 'Die', method: null, detail: hostile } })?.failure)
    .toEqual({ kind: 'Die', method: null })
  expect(reads).toBe(0)
})


test('registered TEST agent and shell snapshot follow actual plugin activation without executing a tool', async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), 'TEST-shell-activation-'))
  const paths = Object.fromEntries(['home', 'data', 'cache', 'config', 'state', 'tmp', 'bin', 'log', 'repos'].map(key => [key, path.join(root, key)]))
  const project = path.join(root, 'TEST-project'), controller = path.join(root, 'TEST-claude')
  await Promise.all([project, controller, ...Object.values(paths)].map(directory => mkdir(directory, { mode: 0o700 })))
  const config = createShellProbeConfig(controller, process.execPath)
  const script = `
    let commands=0,network=0;globalThis.fetch=()=>{network=Math.min(4096,network+1);return Promise.reject(new Error('TEST-network-refused'))};
    const path=require('node:path'),{pathToFileURL}=require('node:url');
    const {verifyOpenCodeV2ServerGraph,verifyOpenCodePackage,verifyOpenCodeV2GraphEffect}=await import('./src/services/opencode/host/OpenCodeV2ServerGraph.ts');
    const graph=await verifyOpenCodeV2ServerGraph('2.0.32'),base=path.dirname(graph.modulePath);
    const selected=async(specifier,name)=>{const entry=await require('node:fs').promises.realpath(Bun.resolveSync(specifier,base));await verifyOpenCodePackage(entry,name,name==='effect'||name.startsWith('@effect/')?'4.0.1':'2.0.32');await verifyOpenCodeV2GraphEffect(entry,graph.effectPath,'2.0.32');return import(pathToFileURL(entry).href)};
    const {Effect,Layer,Scope,Exit,Context,Schema}=await import(pathToFileURL(graph.effectPath).href);
    const [routes,global,cross,spawn,http,sessions,instances,agents,plugins,tools,permissions,schema]=await Promise.all([
      ['@opencode/server/routes','@opencode/server'],['@opencode/util/global','@opencode/util'],['@opencode/util/cross-spawn-spawner','@opencode/util'],
      ['effect/process/ChildProcessSpawner','effect'],['@effect/platform-node/NodeHttpServer','@effect/platform-node'],['@opencode/core/session','@opencode/core'],
      ['@opencode/core/instance/service','@opencode/core'],['@opencode/core/agent','@opencode/core'],['@opencode/core/plugin/service','@opencode/core'],
      ['@opencode/core/tool','@opencode/core'],['@opencode/core/permission','@opencode/core'],['@opencode/schema/schema','@opencode/schema']
    ].map(([specifier,name])=>selected(specifier,name)));
    const spawner=spawn.make(()=>{commands++;return Effect.die(new Error('TEST-command-refused'))});
    const scope=await Effect.runPromise(Scope.make());let result;
    try{result=await Effect.runPromise(Effect.gen(function*(){
      const services=yield* Layer.build(routes.createRoutes({password:'x'.repeat(43),app:{name:'TEST-shell-activation',version:'2.0.32'},
        database:{path:${JSON.stringify(path.join(paths.data!, 'opencode.db'))}},events:{persist:true},
        config:{directory:${JSON.stringify(paths.config)},project:true,content:${JSON.stringify(JSON.stringify(config))}},
        models:{fetch:false,snapshot:true},fs:{filewatcher:false,fff:false}},()=>[],[
          cross.node.replace(Layer.succeed(spawn.ChildProcessSpawner,spawner)),global.node.replace(global.layerWith(${JSON.stringify(paths)}))
        ]).pipe(Layer.provideMerge(http.layerHttpServices)));
      const session=yield* Context.get(services,sessions.Session.Service).create({location:{directory:Schema.decodeUnknownSync(schema.AbsolutePath)(${JSON.stringify(project)})},
        agent:agents.Agent.ID.make('TEST-shell-agent'),permissions:${JSON.stringify(config.agents['TEST-shell-agent'].permissions)}});
      return yield* Context.get(services,instances.Instance.Service).provide(session)(Effect.gen(function*(){
        yield* plugins.Plugin.awaitActivation;
        const agent=yield* (yield* agents.Agent.Service).get(agents.Agent.ID.make('TEST-shell-agent'));
        if(!agent||agent.id!==session.agent)throw new Error('TEST-agent-identity');
        const snapshot=yield* (yield* tools.Tool.Service).snapshot(permissions.Permission.merge(agent.permissions,session.permissions??[]));
        return {agentMatches:true,modelMatches:agent.model?.id==='TEST-model'&&agent.model?.providerID==='TEST-provider',
          permissionsMatch:${JSON.stringify(config.agents['TEST-shell-agent'].permissions)}.every(rule=>agent.permissions.some(actual=>actual.action===rule.action&&actual.resource===rule.resource&&actual.effect===rule.effect)),
          registeredShell:snapshot.definitions.some(definition=>definition.name==='shell')};
      })).pipe(Effect.provide(services));
    }).pipe(Effect.provideService(Scope.Scope,scope)))}finally{await Effect.runPromise(Scope.close(scope,Exit.void))}
    console.log('TEST-RESULT '+JSON.stringify({...result,commands,network}));
  `
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
    env: { HOME: paths.home!, USERPROFILE: paths.home!, XDG_DATA_HOME: paths.data!, XDG_CACHE_HOME: paths.cache!, XDG_CONFIG_HOME: paths.config!,
      XDG_STATE_HOME: paths.state!, TMPDIR: paths.tmp!, TMP: paths.tmp!, TEMP: paths.tmp!, OPENCODE_CONFIG_DIR: paths.config!, PATH: path.dirname(process.execPath), NO_COLOR: '1' } })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const [output, _stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code).toBe(0)
    const line = output.split('\n').find(value => value.startsWith('TEST-RESULT '))
    expect(line).toBeDefined()
    const { network, ...facts } = JSON.parse(line!.slice('TEST-RESULT '.length))
    expect(facts).toEqual({ agentMatches: true, modelMatches: true, permissionsMatch: true, registeredShell: true, commands: 0 })
    expect(Number.isSafeInteger(network) && network >= 0 && network <= 4096).toBe(true)
    console.log(JSON.stringify({ event: 'TEST-plugin-activation', ...facts, blockedFetchAttempts: network }))
  } finally { clearTimeout(timer); await child.exited; await rm(root, { recursive: true, force: true }) }
}, 20_000)
