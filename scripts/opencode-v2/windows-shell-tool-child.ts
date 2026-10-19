import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { openCodeBunVersion } from '../../src/constants/openCodeBunVersion.js'
import { windowsExecutionChildControl, prepareWindowsExecutionChild } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsChildControl.js'
import { windowsExecutionCommandPort } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsCommand.js'
import { loadOpenCodeV2WindowsRuntime } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsRuntime.js'
import { validateExecutionProfile, type SelectedExecutionProfile } from '../../src/services/opencode/host/OpenCodeV2ExecutionBinding.js'
import { verifyOpenCodePackage, verifyOpenCodeV2GraphEffect, verifyOpenCodeV2ServerGraph } from '../../src/services/opencode/host/OpenCodeV2ServerGraph.js'
import { boundOpenCodeRead } from '../../src/services/opencode/transport/OpenCodeBoundedFetch.js'
import { shellProbeFailure, type ShellProbeResult } from './windows-shell-tool-contract.js'

// This entry is launched only by the TEST probe through the normal native plan.
// It creates one real local session and invokes one registered tool; no prompt,
// LLM client, proxy permission service, HTTP test endpoint, or fake ACK is used.
assert.equal(process.platform, 'win32')
assert.equal(process.versions.bun, openCodeBunVersion())
const control = windowsExecutionChildControl(), controller = new AbortController()
let prepared: Awaited<ReturnType<typeof prepareWindowsExecutionChild>> | undefined
let preparation: ReturnType<typeof prepareWindowsExecutionChild> | undefined
let started = false, work: Promise<void> | undefined, finalizer: (() => Promise<void>) | undefined
let closeWork: Promise<void> | undefined
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
const watchdog = setTimeout(() => { void close() }, 180_000)

function close(): Promise<void> {
  return closeWork ??= (async () => {
    controller.abort(); clearTimeout(watchdog)
    let complete = true
    try { if (work) await boundOpenCodeRead(work.catch(() => undefined), 6000) } catch { complete = false }
    try { if (finalizer) await boundOpenCodeRead(finalizer(), 3000) } catch { complete = false }
    try {
      assert.ok(complete && prepared && control.connected())
      // The real control implementation closes the authenticated realpath DLL
      // before serializing this ACK. The parent still requires physical proof.
      await boundOpenCodeRead(control.send({ ...prepared, type: 'closed', scopeClosed: true }), 500)
      control.disconnect(); process.exit(0)
    } catch { process.exit(1) }
  })()
}
control.events.once('disconnect', () => { void close() })
process.once('SIGTERM', () => { void close() })

async function execute(input: Record<string, unknown>): Promise<void> {
  prepared = await preparation
  assert.ok(prepared && input.nonce === prepared.nonce && input.leaseOwnerId === prepared.leaseOwnerId &&
    input.namespace === prepared.namespace && input.pin === '2.0.32')
  assert.ok(Number.isSafeInteger(input.deadline) && Number(input.deadline) > Date.now())
  const deadline = Number(input.deadline)
  const profile = input.profile as SelectedExecutionProfile
  const node = String(input.node), program = String(input.program), marker = String(input.marker)
  let stage: ShellProbeResult['stage'] = 'profile', sessionCreated = false, registeredShell = false
  let shell: ShellProbeResult['shell'] = null, markerPresent = false
  let failure: ShellProbeResult['failure'] = null
  let succeeded = false
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()))
  try {
    await validateExecutionProfile(profile)
    assert.equal(profile.directory, process.cwd())
    assert.match(path.basename(profile.directory), /^TEST-project$/)
    assert.equal(await digest(process.argv[1]!), input.entrySha256)
    assert.equal(await digest(process.execPath), prepared.executableSha256)
    for (const key of ['TMP', 'TEMP', 'LOCALAPPDATA', 'PATH'] as const) process.env[key] = profile.env[key]
    for (const [key, value] of Object.entries(profile.env)) assert.equal(process.env[key], value)
    assert.equal(await realpath(node), node); assert.equal(path.dirname(node), profile.directory)
    assert.equal(await realpath(program), program); assert.equal(path.dirname(program), profile.directory)
    assert.equal(await digest(node), input.nodeSha256); assert.equal(await digest(program), input.programSha256)
    assert.match(marker, /^TEST_SHELL_TOOL_[a-f0-9-]{36}$/)
    const command = `"${node}" "${program}"`
    stage = 'graph'
    const graph = await verifyOpenCodeV2ServerGraph('2.0.32')
    assert.equal(graph.moduleSha256, input.moduleSha256)
    async function selected<T>(specifier: string, packageName: string): Promise<T> {
      const entry = await realpath(Bun.resolveSync(specifier, path.dirname(graph.modulePath)))
      await verifyOpenCodePackage(entry, packageName, packageName.startsWith('@effect/') ? '4.0.1' : '2.0.32')
      await verifyOpenCodeV2GraphEffect(entry, graph.effectPath, '2.0.32')
      return import(pathToFileURL(entry).href) as Promise<T>
    }
    const effect: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
    const { Effect, Layer, Context, Scope, Exit, Schema } = effect
    const [sessionModule, instanceModule, toolModule, agentModule, messageModule, permissionModule, shellModule, schemaModule, http] = await Promise.all([
      selected<typeof import('@opencode/core/session')>('@opencode/core/session', '@opencode/core'),
      selected<typeof import('@opencode/core/instance/service')>('@opencode/core/instance/service', '@opencode/core'),
      selected<typeof import('@opencode/core/tool')>('@opencode/core/tool', '@opencode/core'),
      selected<typeof import('@opencode/core/agent')>('@opencode/core/agent', '@opencode/core'),
      selected<typeof import('@opencode/core/session/message')>('@opencode/core/session/message', '@opencode/core'),
      selected<typeof import('@opencode/core/permission')>('@opencode/core/permission', '@opencode/core'),
      selected<typeof import('@opencode/core/shell/select')>('@opencode/core/shell/select', '@opencode/core'),
      selected<typeof import('@opencode/schema/schema')>('@opencode/schema/schema', '@opencode/schema'),
      selected<typeof import('@effect/platform-node/NodeHttpServer')>('@effect/platform-node/NodeHttpServer', '@effect/platform-node'),
    ])
    stage = 'runtime'
    const runtime = await loadOpenCodeV2WindowsRuntime('2.0.32', graph.moduleSha256, windowsExecutionCommandPort(), profile)
    const scope = await Effect.runPromise(Scope.make())
    let closing: Promise<void> | undefined
    finalizer = () => closing ??= Effect.runPromise(Scope.close(scope, Exit.void))
    stage = 'services'
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      const services = yield* Layer.build(runtime.createRoutes({ hostname: '127.0.0.1', port: 0,
        password: String(input.password), app: { name: 'TEST-shell-tool', version: '2.0.32' },
        database: { path: profile.databasePath }, events: { persist: true },
        config: { directory: profile.config.directory, project: true, content: profile.config.content },
        models: { fetch: false, snapshot: true }, fs: { filewatcher: false, fff: false },
      }, () => []).pipe(Layer.provideMerge(http.layerHttpServices)))
      const sessions = Context.get(services, sessionModule.Session.Service)
      const instance = Context.get(services, instanceModule.Instance.Service)
      stage = 'session'
      const session = yield* sessions.create({ location: { directory: Schema.decodeUnknownSync(schemaModule.AbsolutePath)(profile.directory) },
        agent: agentModule.Agent.ID.make(profile.selection.agent), permissions: [...profile.selection.permissions], title: 'TEST registered shell tool' })
      sessionCreated = true
      stage = 'instance'
      return yield* instance.provide(session)(Effect.gen(function* () {
        const agents = yield* agentModule.Agent.Service
        const agent = yield* agents.get(agentModule.Agent.ID.make(profile.selection.agent))
        assert.ok(agent && agent.id === session.agent)
        stage = 'shell-select'
        const selectedShell = yield* (yield* shellModule.ShellSelect.Service).resolve({ priority: 'compat' })
        const basename = path.basename(selectedShell).toLowerCase().replace(/\.exe$/, '')
        shell = ['cmd', 'powershell', 'pwsh', 'bash'].includes(basename) ? basename as NonNullable<typeof shell> : 'other'
        stage = 'tool-snapshot'
        const tools = yield* (yield* toolModule.Tool.Service).snapshot(permissionModule.Permission.merge(agent.permissions, session.permissions ?? []))
        registeredShell = tools.definitions.some(definition => definition.name === 'shell')
        assert.ok(registeredShell)
        stage = 'tool-execute'
        const result = yield* tools.execute({ sessionID: session.id, agent: agent.id,
          messageID: messageModule.SessionMessage.ID.create(),
          call: { type: 'tool-call', id: 'TEST-shell-tool-call', name: 'shell', input: { command, workdir: profile.directory,
            timeout: Math.max(1, Math.min(10_000, deadline - Date.now())) } } })
        markerPresent = result.content.some(part => part.type === 'text' && part.text.split(/\r?\n/).includes(marker))
        assert.ok(markerPresent)
      })).pipe(Effect.provide(services))
    }).pipe(Effect.provideService(Scope.Scope, scope)), { signal: controller.signal })
    if (Exit.isFailure(exit)) failure = shellProbeFailure(exit.cause)
    else { stage = 'complete'; succeeded = true }
  } catch { failure ??= Object.freeze({ kind: 'unknown', method: null }) }
  finally { clearTimeout(timer) }
  assert.ok(prepared && control.connected())
  await control.send({ type: 'TEST-shell-tool-result', nonce: prepared.nonce, leaseOwnerId: prepared.leaseOwnerId,
    namespace: prepared.namespace, pid: prepared.pid, birth: prepared.birth,
    result: { stage, succeeded, sessionCreated, registeredShell, shell, markerPresent, failure } }, deadline)
}

control.events.on('message', (value: Record<string, unknown>) => {
  try {
    if (value.type === 'prepare') {
      assert.ok(!preparation && !started)
      preparation = prepareWindowsExecutionChild(value)
      void preparation.catch(() => close())
    } else if (value.type === 'start') {
      assert.ok(preparation && !started); started = true
      work = execute(value)
      void work.catch(() => close())
    } else if (value.type === 'close') {
      assert.ok(prepared && value.nonce === prepared.nonce && value.leaseOwnerId === prepared.leaseOwnerId)
      void close()
    }
  } catch { void close() }
})
