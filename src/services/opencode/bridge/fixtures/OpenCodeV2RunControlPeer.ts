import { lstat, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverOpenCodeV2Run, parseRunBinding, parseRunControlRequest, requestOpenCodeV2Run,
  serveOpenCodeV2RunControl, runControlDirectory } from '../OpenCodeV2RunControl.js'
import { writeRunControlFile } from '../OpenCodeV2RunControl.js'
import { executionAssert, type ExecutionAuthority } from '../../execution/OpenCodeV2ExecutionContracts.js'
import { OpenCodeV2ExecutionFetch } from '../../transport/OpenCodeV2ExecutionFetch.js'
import { OpenCodeV2ProviderWire } from '../../transport/OpenCodeV2ProviderWire.js'
import type { ExecutionBridgeClient, ExecutionInbox } from '../../transport/OpenCodeV2ExecutionClientFactory.js'
import { OpenCodeV2RunOwner } from '../OpenCodeV2RunOwner.js'
import { OpenCodeV2TeamBridge } from '../OpenCodeV2TeamBridge.js'
import type { RunBinding, RunExecutionPorts, RunLaunchPlan } from '../OpenCodeV2RunTypes.js'
import { createHash } from 'node:crypto'

// The real owner/session/admission composition runs in this separate process.
// Only its native and lease ports are synthetic. No accepted AdmissionRecord
// is fabricated by the control fixture and no kernel cleanup proof is minted.
function syntheticOwner(dataRoot: string, binding: RunBinding, directory: string, deadline: number, delayed = false,
  acquisitionFailure?: string): OpenCodeV2RunOwner {
  const authority: ExecutionAuthority = { generation: 'v2', pin: '2.0.32', dialect: 'v2-2.0.32', graphSha256: 'a'.repeat(64),
    selectedCli: { path: '/TEST-native', sha256: 'b'.repeat(64), version: '2.0.32' },
    child: { pid: process.pid, birth: { format: 'linux-start-ticks', value: '1', bootId: 'TEST' },
      executablePath: process.execPath, sha256: 'c'.repeat(64) }, hostInstanceId: 'TEST', profileEpoch: 'TEST',
    profileRoot: '/TEST-profile', directory: '/TEST-project', leaseOwnerId: 'TEST' }
  const context = 'silent TEST context', config = JSON.stringify({ mcp: { servers: { 'agent-teams': { type: 'local', command: [process.execPath, fileURLToPath(new URL('./OpenCodeV2ControllerToolsPeer.ts', import.meta.url))] } } } })
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const plan: RunLaunchPlan = { dataRoot, binding, deadline,
    source: { entryPath: '/TEST-entry.ts', entrySha256: 'd'.repeat(64), bunPath: '/TEST-bun', bunSha256: 'c'.repeat(64),
      files: [{ path: '/TEST-entry.ts', sha256: 'd'.repeat(64) }], env: {} },
    members: [{ memberId: 'worker', laneId: 'primary', originalSessionId: 'ses_TESToriginal',
      native: { generation: 'v2', version: '2.0.32', dialect: 'v2-2.0.32', executablePath: '/TEST-native',
        executableSha256: 'b'.repeat(64), packageName: '@opencode/cli-linux-x64', runtimeMode: 'source', entrySha256: 'e'.repeat(64),
        bun: { path: '/TEST-bun', sha256: 'c'.repeat(64) }, graph: { sha256: 'a'.repeat(64), files: [] } },
      profile: { epoch: 'TEST', root: '/TEST-profile', directory: '/TEST-project', databasePath: '/TEST-profile/data/db',
        env: {}, envSha256: hash('{}'), config: { directory: '/TEST-profile/config', content: config, sha256: hash(config) },
        selection: { agent: 'worker', model: { providerID: 'TEST', id: 'TEST' }, permissions: [{ action: '*', resource: '*', effect: 'ask' }] } },
      bootstrap: { key: 'test.context', value: context, contextHash: hash(context), briefingHash: 'f'.repeat(64) },
      controllerMcpName: 'agent-teams', advertisedTools: [] }],
  }
  let created = false, instruction: Parameters<ExecutionBridgeClient['putInstruction']>[2] = null
  const inbox: ExecutionInbox[] = [], effects = { prompted: 0, closed: 0 }
  const native: ExecutionBridgeClient = {
    authority,
    getSession: async id => {
      if (!created) {
        const endpoint = 'http://127.0.0.1:1'
        const wire = new OpenCodeV2ExecutionFetch(endpoint, '2.0.32', '/TEST-project', 'TEST-only', { deadline: Date.now() + 5000 },
          async () => new Response(JSON.stringify({ _tag: 'SessionNotFoundError', sessionID: id, message: 'synthetic missing' }),
            { status: 404, headers: { 'content-type': 'application/json' } }))
        try { await wire.fetch(`${endpoint}/api/session/${id}`); throw new Error('TEST_missing_not_classified') }
        finally { await wire.dispose() }
      }
      return { id, directory: '/TEST-project', agent: 'worker', model: { providerID: 'TEST', id: 'TEST' }, timeCreated: 1 }
    },
    createSession: async input => { created = true; return { id: input.sessionID, directory: '/TEST-project', agent: input.agent, model: input.model, timeCreated: 1 } },
    promptQueue: async (sessionID, input) => {
      effects.prompted++; await writeRunControlFile(directory, 'synthetic-effects.json', effects)
      const receipt: ExecutionInbox = { id: input.nativeInputID, sessionID, type: 'user', timeCreated: 1,
        delivery: 'queue', payload: { text: input.text } }
      inbox.push(receipt); return receipt
    },
    inbox: async () => inbox, log: async () => ({ events: [], synced: true, watermark: null }),
    messages: async () => ({ data: [], previous: null, next: null }), dispose: async () => {},
    putInstruction: async (_id, _key, value) => { instruction = value }, instructions: async () => [{ key: 'test.context', value: instruction }],
    addMcp: async () => {}, connectMcp: async () => {}, disconnectMcp: async () => {}, mcp: async () => [{ name: 'agent-teams', status: 'connected' }],
    interrupt: async () => ({ interrupted: true }), cancelInbox: async () => {}, permissions: async () => [],
    permission: async () => { throw new Error('TEST_permission_absent') }, replyPermission: async () => {},
  }
  const ports: RunExecutionPorts = {
    acquire: async (_native, _profile, context) => {
      while (delayed) {
        context.signal?.throwIfAborted()
        executionAssert(Date.now() < context.deadline, 'TEST_acquisition_deadline')
        try { await lstat(path.join(directory, 'TEST-release-initialization')); break }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      // A real provider read through the wire (needs OpenCodeV2ProviderEndpointPreload.ts),
      // which fails at its decode stage with 404 like the selected-auth provider lookup.
      if (acquisitionFailure === 'TEST-provider-read-404') {
        const wire = new OpenCodeV2ProviderWire(authority, Date.now() + 5000)
        try { await wire.fetch(`http://127.0.0.1:1/api/provider/TEST?location%5Bdirectory%5D=${encodeURIComponent(authority.directory)}`) }
        finally { await wire.dispose() }
        throw new Error('TEST_provider_read_not_refused')
      }
      // Otherwise the owner's own initialization failure, as an exact code.
      if (acquisitionFailure !== undefined) throw new Error(acquisitionFailure)
      return { authority, signal: new AbortController().signal, close: async () => {
      effects.closed++; await writeRunControlFile(directory, 'synthetic-effects.json', effects)
      throw new Error('TEST_no_kernel_cleanup_receipt')
    } } },
    client: async owned => { executionAssert(owned === authority, 'TEST_lease_not_owned'); return native },
  }
  return new OpenCodeV2RunOwner(plan, directory, ports)
}

// Synthetic Unix control processes only; no official client/server, model,
// host acquisition, execution profile, or application project is loaded.
const [mode, dataRoot, rawBinding, rawRequest] = process.argv.slice(2)
if (mode === 'sentinel') {
  process.stdout.write('ready\n')
  setInterval(() => undefined, 1000)
  process.on('message', message => { if (message === 'ping') process.send?.('alive') })
} else {
  executionAssert(dataRoot && rawBinding, 'TEST_args_missing')
  const binding = parseRunBinding(JSON.parse(rawBinding))
  if (mode === 'call' || mode === 'semantic-send') {
    executionAssert(rawRequest, 'TEST_request_missing')
    const request = parseRunControlRequest(JSON.parse(rawRequest))
    if (mode === 'semantic-send') {
      executionAssert(request.operation === 'send', 'TEST_send_required')
      const bridge = new OpenCodeV2TeamBridge(dataRoot, binding)
      const identity = request.intent.identity
      const result = await bridge.send(request, { requestId: identity.requestId, teamId: binding.teamId, teamName: binding.teamId,
        laneId: 'primary', memberName: request.memberId, projectPath: '/TEST-project', runId: binding.runId,
        body: { deliveryAttemptId: identity.deliveryAttemptId, messageId: identity.localMessageId } }, 5000)
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exit(0)
    }
    const record = await discoverOpenCodeV2Run(dataRoot, binding.teamId, binding.runId)
    executionAssert(record, 'TEST_owner_missing')
    const result = await requestOpenCodeV2Run(record, request, 5000)
    process.stdout.write(JSON.stringify(result) + '\n')
  } else {
    executionAssert(mode === 'serve' || mode === 'serve-delayed' || mode === 'serve-fail' || mode.startsWith('serve-drop-'), 'TEST_mode_invalid')
    const drop = mode.startsWith('serve-drop-') ? mode.slice('serve-drop-'.length) : null
    // serve-fail: the released acquisition throws rawRequest; the owner then retires itself.
    const failing = mode === 'serve-fail'
    let control: Awaited<ReturnType<typeof serveOpenCodeV2RunControl>> | undefined
    const directory = runControlDirectory(dataRoot, binding.teamId, binding.runId)
    const deadline = Date.now() + 20_000
    const owner = syntheticOwner(dataRoot, binding, directory, deadline, mode === 'serve-delayed' || failing,
      failing ? rawRequest ?? 'TEST_owner_failure' : undefined)
    control = await serveOpenCodeV2RunControl(directory, binding, deadline, 'a'.repeat(64),
      async (request, operationDeadline) => {
        // A lost stop reply: retire without answering. The durable receipt (or
        // its absence) decides later confirmation from the same-run archive.
        if (drop && request.operation === 'stop') {
          if (drop === 'archive' || drop === 'unknown') {
            await writeRunControlFile(directory, 'tombstone.json', { binding })
            await writeRunControlFile(directory, 'stop.json', { binding, receipt: { kind: 'stop',
              state: drop === 'archive' ? 'stopped' : 'cleanup_unknown',
              members: drop === 'archive' ? [{ memberId: 'worker', cleanup: { scopeClosed: true, processRetired: true,
                descendantsRetired: true, pid: 4242, birth: { format: 'darwin-pidversion', value: '4242:1', bootId: null } },
              errors: [] }] : [] } })
          }
          if (drop === 'corrupt') {
            const current = JSON.parse((await readFile(path.join(directory, 'control.json'))).toString('utf8'))
            await writeRunControlFile(directory, 'control.json', { ...current, sourceSha256: 'b'.repeat(64) })
          }
          await rm(path.join(directory, 'control.sock'), { force: true })
          process.exit(0)
        }
        return owner.execute(request, operationDeadline)
      })
    let retiring: Promise<void> | undefined
    const retire = () => retiring ??= (async () => { await owner.stop(); await owner.awaitCleanupTerminal(); await control?.close() })()
    process.once('SIGTERM', () => { void retire().finally(() => process.exit(0)) })
    void owner.stopped.then(() => { setTimeout(() => { void retire().finally(() => process.exit(0)) }, 100) })
    if (mode === 'serve-delayed' || failing) process.stdout.write('ready\n')
    // Like the production entry, a failed initialization exits through owner.stopped.
    if (failing) await owner.ready().catch(() => undefined)
    else await owner.ready()
    if (mode !== 'serve-delayed' && !failing) process.stdout.write('ready\n')
  }
}
