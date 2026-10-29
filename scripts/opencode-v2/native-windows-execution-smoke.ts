// Native Windows source-owner proof under the exact shipped Bun. The packaged
// server/PTY smokes cover extracted support separately. This submits no model
// input: the MCP peer is the existing synthetic SDK schema fixture, not the app.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunControlRecord, RunMemberStatus } from '../../src/services/opencode/bridge/OpenCodeV2RunTypes.js'

const MODEL = 'openrouter/openai/gpt-4.1-mini'
const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
const failure = (error: unknown) => error instanceof Error ? error.message.slice(0, 512) : 'Unknown native execution failure'
async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3000
  do {
    try { process.kill(pid, 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
    await Bun.sleep(50)
  } while (Date.now() < deadline)
  return false
}

export async function main(cliArgument: string, nodeArgument: string, receiptArgument: string, platform: string): Promise<void> {
  const receipt = path.resolve(receiptArgument), originalEnvironment = { ...process.env }, originalDirectory = process.cwd()
  const evidence: Record<string, unknown> = { schemaVersion: 1, ok: false, mode: 'source-owner',
    sourceHead: process.env.PR_HEAD_SHA ?? null,
    platform: process.platform, arch: process.arch, bunVersion: Bun.version, model: MODEL,
    controller: 'synthetic-sdk-schema-peer', modelInference: 'not-exercised' }
  let fixture: string | undefined, owner: RunControlRecord | undefined, ready: RunMemberStatus | null = null
  let launchAttempted = false, stopConfirmed = false, stage = 'platform', providerRequests = 0
  let rejectProvider: ReturnType<typeof Bun.serve> | undefined
  const mark = (next: string) => { stage = next; console.log(JSON.stringify({ smoke: 'native-windows-execution', stage })) }
  try {
    assert.equal(process.platform, 'win32'); assert(['arm64', 'x64'].includes(process.arch))
    assert.equal(`${process.platform}-${process.arch}`, platform); assert.equal(Bun.version, '1.4.3')
    const bun = await realpath(process.execPath), base = path.dirname(path.dirname(bun))
    assert.equal(bun, await realpath(path.join(base, 'bun', 'bun.exe')))
    const { validatePackagedOpenCodeIdentity } = await import('../../src/cli/packagedOpenCodeDelivery.js')
    const identity = validatePackagedOpenCodeIdentity(JSON.parse(await readFile(path.join(base, 'opencode-delivery.json'), 'utf8')))
    assert.equal(identity.platform, process.platform); assert.equal(identity.arch, process.arch)
    assert.equal(identity.bunVersion, Bun.version); assert.equal(identity.bunSha256, await sha(bun))
    const sourceCommit = (await readFile(path.join(base, 'COMMIT_SHA'), 'utf8')).trim()
    assert.match(originalEnvironment.PR_HEAD_SHA ?? '', /^[a-f0-9]{40}$/, 'Exact source head required')
    assert.equal(sourceCommit, originalEnvironment.PR_HEAD_SHA, 'Shipped artifact source head changed')
    evidence.shippedBun = { sha256: identity.bunSha256, sourceCommit }
    const cli = await realpath(cliArgument), selectedNode = await realpath(nodeArgument)
    const systemRoot = await realpath(originalEnvironment.SystemRoot ?? originalEnvironment.SYSTEMROOT ?? 'C:\\Windows')
    fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-native-windows-execution-')))
    const project = path.join(fixture, 'project'), controller = path.join(fixture, 'controller'), controllerRuntime = path.join(fixture, 'controller-runtime')
    const testHome = path.join(fixture, 'home'), temporary = path.join(fixture, 'tmp'), claude = path.join(fixture, 'claude')
    const teamId = 'TEST-native-execution', runId = randomUUID()
    for (const directory of [project, controller, controllerRuntime, testHome, temporary, 'appdata', 'localappdata', 'config', 'data', 'cache', 'state',
      path.join(claude, 'teams', teamId), path.join(claude, 'tasks', teamId)])
      await mkdir(path.isAbsolute(directory) ? directory : path.join(fixture, directory), { recursive: true })
    const node = path.join(controllerRuntime, 'node.exe'), peer = path.join(controller, 'index.mjs')
    await copyFile(selectedNode, node)
    await writeFile(path.join(controller, 'package.json'), JSON.stringify({ name: 'test-native-controller-schema-peer', version: '1.0.0', type: 'module' }))
    const built = await Bun.build({ entrypoints: [fileURLToPath(new URL('../../src/services/opencode/bridge/fixtures/OpenCodeV2ControllerToolsPeer.ts', import.meta.url))],
      target: 'node', format: 'esm', packages: 'bundle', splitting: false })
    assert(built.success && built.outputs.length === 1, 'Controller SDK fixture did not bundle')
    await writeFile(peer, new Uint8Array(await built.outputs[0]!.arrayBuffer()))
    evidence.controllerRuntime = { sha256: await sha(node), entrySha256: await sha(peer) }
    // A local rejecting endpoint cannot provide inference. Any provider request fails this gate.
    rejectProvider = Bun.serve({ hostname: '127.0.0.1', port: 0,
      fetch: () => { providerRequests++; return new Response('TEST: inference disabled', { status: 503 }) } })
    const providerBaseUrl = `http://127.0.0.1:${rejectProvider.port}/v1`
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, { SystemRoot: systemRoot, WINDIR: systemRoot,
      PATH: [controllerRuntime, path.dirname(bun), path.join(systemRoot, 'System32'), path.join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
      HOME: testHome, USERPROFILE: testHome, TMPDIR: temporary, TEMP: temporary, TMP: temporary,
      APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata'),
      XDG_CONFIG_HOME: path.join(fixture, 'config'), XDG_DATA_HOME: path.join(fixture, 'data'),
      XDG_CACHE_HOME: path.join(fixture, 'cache'), XDG_STATE_HOME: path.join(fixture, 'state'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(fixture, 'runtime-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(fixture, 'runtime-cache'),
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: cli, CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: node,
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: peer, AGENT_TEAMS_MCP_CLAUDE_DIR: claude,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { openrouter: { options: { baseURL: providerBaseUrl } } } }),
      NODE_ENV: 'development', NO_COLOR: '1' })
    process.chdir(project)
    mark('selected-auth')
    const { OpenCodeProfileManager } = await import('../../src/services/opencode/OpenCodeProfileManager.js')
    const { upsertOpenCodeApiAuthCredential } = await import('../../src/services/opencode/OpenCodeAuthStore.js')
    await upsertOpenCodeApiAuthCredential({ authPath: new OpenCodeProfileManager().getGlobalAuthPath(),
      providerId: 'openrouter', apiKey: 'TEST-noncredential' })
    const { inspectOpenCodeV2SourceAvailability, buildOpenCodeV2InternalRunPlan } = await import('../../src/services/opencode/bridge/OpenCodeV2LaunchPlan.js')
    const { launchExplicitOpenCodeV2Run } = await import('../../src/services/opencode/bridge/OpenCodeV2RunOwner.js')
    const { awaitOpenCodeV2RunMemberReadiness, requestOpenCodeV2Run, OPEN_CODE_V2_RUN_INITIALIZATION_MS } = await import('../../src/services/opencode/bridge/OpenCodeV2RunControl.js')
    const { openCodeV2EngineVersion } = await import('../../src/services/opencode/compatibility/OpenCodeV2Registry.js')
    mark('genuine-receipt')
    const selection = await inspectOpenCodeV2SourceAvailability({ schemaVersion: 1, command: 'opencode.readiness',
      requestId: 'TEST-native-execution', cwd: project, startedAt: new Date().toISOString(), timeoutMs: 300_000, body: { selectedModel: MODEL } })
    const builtPlan = await buildOpenCodeV2InternalRunPlan(selection, { teamId, teamName: teamId, runId, laneId: 'primary',
      selectedModel: MODEL, effort: 'default', members: [{ name: 'TEST-member', prompt: 'Wait for app task delivery.' }] }, randomUUID())
    // Shorten only the original unlaunched plan; retain the production initialization and stop budgets.
    const plan = { ...builtPlan, deadline: Math.min(builtPlan.deadline, Date.now() + 360_000) }, member = plan.members[0]!
    assert.equal(plan.executionProbe, undefined); assert.equal(member.native.runtimeMode, 'source')
    assert.equal(JSON.parse(member.profile.config.content).providers?.openrouter?.settings?.baseURL, providerBaseUrl, 'Selected provider endpoint changed')
    evidence.native = { version: selection.native.version, engineVersion: openCodeV2EngineVersion(selection.native), packageName: selection.native.packageName,
      executableSha256: selection.native.executableSha256, graphSha256: selection.installedGraphSHA256, graphFiles: selection.installedGraphFiles }
    try {
      mark('owner-launch'); launchAttempted = true
      owner = await launchExplicitOpenCodeV2Run(plan)
      assert.deepEqual(owner.binding, plan.binding)
      evidence.owner = { process: owner.process, sourceSha256: owner.sourceSha256 }
      mark('member-readiness')
      const readinessMs = Math.min(OPEN_CODE_V2_RUN_INITIALIZATION_MS, owner.deadline - Date.now() - 45_000)
      assert(readinessMs > 0, 'Readiness budget exhausted')
      ready = await awaitOpenCodeV2RunMemberReadiness(owner, { memberId: member.memberId, originalSessionId: member.originalSessionId,
        selectedModel: MODEL, selectedVariant: 'default', pin: openCodeV2EngineVersion(selection.native) }, readinessMs)
      assert(ready?.runtimePid && ready.bootstrap?.verified && ready.bootstrap.missingNativeMessageID, 'Original member did not become ready')
      assert(ready.controllerTools?.server === 'agent-teams', 'Selected controller proof missing')
      assert(ready.controllerTools.tools.some(tool => tool.name === 'message_send'), 'Real MCP schema readback missing')
      evidence.member = ready
      const target = { memberId: member.memberId, originalSessionId: member.originalSessionId }
      const mcp = await requestOpenCodeV2Run(owner, { operation: 'mcp', ...target }, 10_000)
      assert(mcp.kind === 'mcp' && mcp.servers.filter(server => server.name === 'agent-teams' && server.status === 'connected').length === 1)
      const transcript = await requestOpenCodeV2Run(owner, { operation: 'transcript', ...target }, 10_000)
      assert(transcript.kind === 'transcript'); evidence.sessionMessageCount = transcript.messages.data.length
      assert.equal(providerRequests, 0, 'Unexpected model/provider request')
    } catch (error) {
      evidence.failure = failure(error); evidence.failureStage = stage
      if (owner) evidence.lastStatus = await requestOpenCodeV2Run(owner, { operation: 'status' }, 5000).catch(failure)
    } finally {
      if (owner) {
        mark('physical-stop')
        try {
          const stopped = await requestOpenCodeV2Run(owner, { operation: 'stop' }, 45_000)
          evidence.stop = stopped
          assert(stopped.kind === 'stop' && stopped.state === 'stopped' && stopped.ownerRetired === true, 'Public stop unconfirmed')
          assert.equal(stopped.members.length, 1)
          const retired = stopped.members[0]!
          assert(retired.memberId === member.memberId && retired.errors.length === 0 && retired.cleanup?.scopeClosed === true &&
            retired.cleanup.processRetired === true && typeof retired.cleanup.descendantsRetired === 'boolean', 'Physical cleanup unconfirmed')
          if (ready?.runtimePid) assert.equal(retired.cleanup.pid, ready.runtimePid)
          // Windows reports descendant retirement honestly as best effort. Check both owned leader PIDs independently.
          const retiredPids = await Promise.all([gone(owner.process.pid), gone(retired.cleanup.pid)])
          evidence.ownedProcessesGone = retiredPids; assert(retiredPids.every(Boolean), 'Owned process still alive')
          stopConfirmed = true
        } catch (error) { evidence.stopFailure = failure(error) }
      }
    }
    assert(ready && stopConfirmed && !evidence.failure && !evidence.stopFailure, 'Native readiness/stop proof incomplete')
    assert.equal(providerRequests, 0, 'Unexpected model/provider request')
    evidence.ok = true
  } catch (error) {
    evidence.failure ??= failure(error); evidence.failureStage ??= stage
  } finally {
    evidence.providerRequests = providerRequests
    rejectProvider?.stop(true)
    process.chdir(originalDirectory)
    // Unknown launch has no returned authority to invent or PID-kill. Retain its
    // TEST files for the genuine owner's finite deadline and runner diagnostics.
    if (fixture && (!launchAttempted || stopConfirmed)) {
      try { await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); evidence.fixtureRemoved = true }
      catch (error) { evidence.fixtureRemoved = false; evidence.cleanupFailure = failure(error); evidence.ok = false }
    } else if (fixture) { evidence.fixtureRetained = fixture; evidence.cleanupUnknown = true }
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnvironment)
    await writeFile(receipt, JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify({ ok: evidence.ok, receipt }))
    if (evidence.ok !== true) process.exitCode = 1
  }
}

if (import.meta.main) {
  const [cli, node, receipt, platform] = process.argv.slice(2)
  assert(cli && node && receipt && platform, 'Usage: native-windows-execution-smoke.ts <opencode.exe> <node.exe> <evidence.json> <win32-arch>')
  await main(cli, node, receipt, platform)
}
