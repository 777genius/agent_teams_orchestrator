import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsOwnerFilesystem.js'
import { createWindowsExecutionHttpClient } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsHTTP.js'
import { verifyWindowsHttpDisconnectContract } from './windows-http-disconnect-contract.js'

assert.equal(process.platform, 'win32'); assert.equal(process.versions.bun, '1.3.11')
const requestedRoot = process.argv[2], receiptPath = process.argv[3]
assert.ok(requestedRoot && receiptPath && path.win32.isAbsolute(requestedRoot) && path.win32.isAbsolute(receiptPath))
assert.match(path.win32.basename(requestedRoot), /^TEST-windows-http-[a-zA-Z0-9-]+$/)
const powershell = path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'pwsh.exe')
const facts: Record<string, unknown> = { schema: 1, qualified: false, fullTaskQualified: false, executionAdapterQualified: false, officialServerQualified: false, kind: 'production-native-http-mechanisms', ancestorSetupTestOnly: true }
let failure: unknown
function record(value: unknown): Record<string, unknown> { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown> }
async function bounded<T>(promise: Promise<T>, code: string, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function until<T>(read: () => T | undefined, code = 'windows_http_wait_timeout'): Promise<T> {
  const deadline = Date.now() + 10000
  for (;;) { const value = read(); if (value !== undefined) return value; assert.ok(Date.now() < deadline, code); await Bun.sleep(10) }
}
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
let artifact: Awaited<ReturnType<typeof resolveWindowsNativeArtifact>>
const moduleDirectory = fileURLToPath(new URL('../../src/services/opencode/host/windows/', import.meta.url))

async function run(disconnect: 'child-pipe' | 'broker') {
  const root = requestedRoot + '-' + disconnect, nonce = randomUUID(), leaseOwnerId = randomUUID()
  const journal = path.join(root, 'ancestor-journal.json'), fencePath = path.join(root, '.native-owner')
  const result: Record<string, unknown> = { disconnect, qualified: false, nonce }
  facts[disconnect] = result
  const broker = createWindowsNativeBroker(artifact), filesystem = createWindowsOwnerFilesystem(input => broker.request(input.op, input))
  const handles: WindowsOwnerDirectory[] = [], messages: Record<string, unknown>[] = []
  let sid: string | undefined, mapping: Record<string, unknown> | undefined, peer: Record<string, unknown> | undefined
  let failed: Record<string, unknown> | undefined, helperCloseCode: number | null | undefined, launched = false, retired = false
  let transportFailure: Error | undefined
  let disconnectTransactionId: string | undefined
  const disconnectFrames: Record<string, unknown>[] = []
  const frameCounts: Record<string, number> = {}; let receivedBytes = 0
  const http = createWindowsExecutionHttpClient(
    frame => {
      if (frame.action === 'request' && frame.path === '/disconnect') disconnectTransactionId = String(frame.id)
      return broker.request('send', { value: { ...frame, nonce, leaseOwnerId } }).then(() => undefined)
    },
    () => { if (!broker.ended()) void broker.request('retire').catch(() => undefined) },
  )
  broker.events.on('error', error => { transportFailure ??= error; http.fail(transportFailure) })
  broker.events.on('close', code => { helperCloseCode = code; transportFailure ??= new Error('execution_containment_helper_closed'); http.fail(transportFailure) })
  broker.events.on('connected', value => { peer = record(value) })
  broker.events.on('failed', value => { failed = record(value); transportFailure ??= new Error('execution_containment_launcher_denied'); http.fail(transportFailure) })
  broker.events.on('message', value => {
    const frame = record(value); assert.equal(frame.nonce, nonce); assert.equal(frame.leaseOwnerId, leaseOwnerId)
    if (frame.type === 'windowsHTTP') {
      frameCounts[String(frame.action)] = (frameCounts[String(frame.action)] ?? 0) + 1
      if (frame.action === 'data' && frame.direction === 'response') receivedBytes += Buffer.from(String(frame.bytes), 'base64').length
      if (frame.id === disconnectTransactionId) {
        assert.ok(disconnectFrames.length < 128, 'windows_http_disconnect_frame_limit')
        disconnectFrames.push({ action: frame.action, direction: frame.direction,
          ...(frame.action === 'data' ? { bytes: Buffer.from(String(frame.bytes), 'base64').length } : {}) })
      }
      http.accept(frame)
    } else messages.push(frame)
  })
  const environment = { SystemRoot: process.env.SystemRoot!, WINDIR: process.env.WINDIR!, LOCALAPPDATA: root,
    PATH: `${root};${path.join(process.env.SystemRoot!, 'System32')}`, USERPROFILE: root, HOME: root, TEMP: root, TMP: root, PWD: root }
async function ps(script: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([powershell, '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PSModulePath: path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'Modules'), TEST_ROOT: root, TEST_NONCE: nonce, TEST_JOURNAL: journal, ...extra }, stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) {
    const category = /identity references could not be translated/i.test(err) ? 'sid_translation' : 'powershell'
    throw new Error(`windows_command_setup_failed:${category}:${code}`)
  }
  return out.trim()
}
  let localFailure: unknown, brokerDisconnected = false, phase = 'setup'
  try {
    const parent = await filesystem.createDirectory(root); await parent.close()
    const fence = await filesystem.createDirectory(fencePath); handles.push(fence)
    const ownerRecord = { schema: 1, testOnly: true, nonce, leaseOwnerId }
    await fence.writeExclusive('owner.json', ownerRecord)
    await copyFile(process.execPath, path.join(root, 'bun.exe'))
    const entry = fileURLToPath(new URL('./windows-http-child-probe.ts', import.meta.url))
    const build = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm' })
    assert.equal(build.success, true); assert.equal(build.outputs.length, 1)
    const childEntry = path.join(root, 'http-child.js'); await writeFile(childEntry, Buffer.from(await build.outputs[0]!.arrayBuffer()))
    result.bundleSha256 = await digest(childEntry); result.childFixtureSha256 = await digest(entry)
    result.childFixtureLfSha256 = createHash('sha256').update((await readFile(entry, 'utf8')).replace(/\r\n/g, '\n')).digest('hex')
    await writeFile(journal, '[]')
  sid = await ps(`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class TestAppSid {
[DllImport("userenv.dll",CharSet=CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
[DllImport("advapi32.dll")] public static extern IntPtr FreeSid(IntPtr sid);
}
'@
$native=[IntPtr]::Zero
if([TestAppSid]::DeriveAppContainerSidFromAppContainerName(('AgentTeams.OpenCodeV2.'+$env:TEST_NONCE),[ref]$native)-ne 0){throw 'TEST SID derivation failed'}
try{$sid=[System.Security.Principal.SecurityIdentifier]::new($native).Value}finally{[TestAppSid]::FreeSid($native)|Out-Null}
$sid
`)
  assert.match(sid, /^S-1-15-2-/)
  await ps(`
$ErrorActionPreference='Stop';$sid=$env:TEST_SID
$identity=[System.Security.Principal.SecurityIdentifier]::new($sid)
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($identity,'ReadAndExecute','None','None','Allow')
$planned=[System.Collections.Generic.List[string]]::new();$ancestor=$env:TEST_ROOT
while($ancestor){$planned.Add($ancestor);$info=[System.IO.DirectoryInfo]::new($ancestor).Parent;if(!$info){break};$ancestor=$info.FullName}
[IO.File]::WriteAllText($env:TEST_JOURNAL,(ConvertTo-Json -InputObject @($planned)),[Text.UTF8Encoding]::new($false))
foreach($ancestor in $planned){$acl=Get-Acl -LiteralPath $ancestor;$acl.AddAccessRule($rule);Set-Acl -LiteralPath $ancestor -AclObject $acl}
& icacls.exe $env:TEST_ROOT /setintegritylevel '(OI)(CI)L' /T /Q | Out-Null
if($LASTEXITCODE-ne 0){throw 'TEST low label failed'}
`, { TEST_SID: sid })
    phase = 'native-launch'; launched = true
    mapping = record(await broker.request('launch', { executable: path.join(root, 'bun.exe'), entry: childEntry, cwd: root, env: environment,
      writableRoots: [root], readOnlyRoots: [], protectedRoots: [fencePath], nonce, leaseOwnerId }))
    assert.equal(mapping.containerSid, sid)
    const main = record(mapping.bun)
    await until(() => peer); assert.equal(peer!.clientPID, main.nativePID); assert.deepEqual(peer!.bun, main)
    result.nativeMain = main; result.authenticatedPeer = peer
    await broker.request('send', { value: { type: 'prepare', nonce, leaseOwnerId, namespace: mapping.namespace, birth: main.birth, executableSha256: await digest(path.join(root, 'bun.exe')) } })
    const ready = await until(() => messages.find(value => value.type === 'ready'))
    assert.equal(ready.pid, main.nativePID); assert.deepEqual(ready.birth, main.birth); assert.equal(ready.namespace, mapping.namespace)
    assert.equal(ready.executableSha256, await digest(path.join(root, 'bun.exe')))
    assert.equal(typeof ready.baseUrl, 'string'); const baseUrl = String(ready.baseUrl)
    http.bindOrigin(baseUrl); result.baseUrl = baseUrl
    if (disconnect === 'child-pipe') {
      phase = 'native-filesystem-api-diagnostic'
      await broker.request('send', { value: { type: 'testFilesystem', nonce, leaseOwnerId } })
      const diagnostic = await until(() => messages.find(value => value.type === 'testFilesystemResult'), 'windows_http_filesystem_diagnostic_missing')
      const names = new Map([['node-relative', 'node-relative.txt'], ['node-absolute', 'node-absolute.txt'], ['node-sync-relative', 'node-sync.txt'],
        ['node-relative-no-dot', 'nodeplain'], ['bun-relative', 'bun-relative.txt'], ['bun-absolute', 'bun-absolute.txt']])
      assert.ok(Array.isArray(diagnostic.operations) && diagnostic.operations.length === names.size)
      const expectedBytes = Buffer.from('native-fs-bytes-é\0\x01\xff', 'utf8'), verified: Record<string, unknown>[] = []
      for (const item of diagnostic.operations) {
        const operation = record(item), name = names.get(String(operation.id)); assert.ok(name); names.delete(String(operation.id))
        if (operation.written === true) {
          assert.equal(operation.absoluteNodeReadMatches, true)
          const target = path.join(root, name), info = await stat(target)
          assert.ok(info.isFile()); assert.equal(info.size, expectedBytes.length)
          assert.deepEqual(await readFile(target), expectedBytes)
          verified.push({ ...operation, hostReadMatches: true })
        } else verified.push(operation)
      }
      assert.equal(names.size, 0)
      result.filesystemDiagnostic = { qualified: verified.every(item => item.hostReadMatches === true), operations: verified }
      phase = 'native-cwd-reopen-diagnostic'
      await broker.request('send', { value: { type: 'testReopenCwd', nonce, leaseOwnerId } })
      const reopened = await until(() => messages.find(value => value.type === 'testReopenCwdResult'), 'windows_http_cwd_diagnostic_missing')
      result.cwdReopenDiagnostic = reopened
      if (reopened.reopened === true) assert.equal(reopened.cwdUnchanged, true)
      if (reopened.written === true) {
        assert.equal(reopened.absoluteNodeReadMatches, true)
        const target = path.join(root, 'node-reopened.txt'), info = await stat(target)
        assert.ok(info.isFile()); assert.equal(info.size, expectedBytes.length); assert.deepEqual(await readFile(target), expectedBytes)
        result.cwdReopenDiagnostic = { ...reopened, hostReadMatches: true }
      }
      phase = 'get-post'
      const get = await bounded(http.fetch(baseUrl + '/get'), 'windows_http_get_timeout')
      assert.equal(get.headers.get('x-native-http'), 'production-transport'); assert.equal(await bounded(get.text(), 'windows_http_get_body_timeout'), 'native-http-get-é')
      const expected = Buffer.alloc(23000); for (let i = 0; i < expected.length; i++) expected[i] = i % 251
      const post = await bounded(http.fetch(baseUrl + '/post', { method: 'POST', body: expected }), 'windows_http_post_timeout')
      assert.equal(post.status, 201); assert.equal(post.headers.get('x-upload-bytes'), '23000')
      assert.deepEqual(Buffer.from(await bounded(post.arrayBuffer(), 'windows_http_post_body_timeout')), Buffer.alloc(100000, 0xa7))
      result.getPassed = true; result.binaryPostBytes = expected.length; result.binaryResponseBytes = 100000
      phase = 'sse-window'
      const beforeSse = receivedBytes, sse = await bounded(http.fetch(baseUrl + '/sse'), 'windows_http_sse_timeout')
      assert.equal(sse.headers.get('content-type'), 'text/event-stream')
      await Bun.sleep(150); assert.ok(receivedBytes - beforeSse > 0 && receivedBytes - beforeSse <= 32768)
      result.sseUnreadWindowBytes = receivedBytes - beforeSse
      const reader = sse.body!.getReader(); const event = await bounded(reader.read(), 'windows_http_sse_read_timeout')
      assert.equal(event.done, false); assert.ok(new TextDecoder().decode(event.value).startsWith('data: '))
      phase = 'sse-cancel-ack'
      const cancelledBefore = frameCounts.cancelled ?? 0
      await bounded(reader.cancel(), 'windows_http_cancel_ack_timeout')
      assert.equal(frameCounts.cancelled, cancelledBefore + 1); result.sseCancelAck = true
      phase = 'server-aborted-evidence'
      const observed = await until(() => messages.find(value => value.type === 'testSseCancellation'), 'windows_http_server_abort_not_observed')
      result.serverCancellation = observed
      assert.equal(observed.event, 'request-aborted'); assert.equal(observed.requestAborted, true); assert.equal(observed.socketDestroyed, true)
      // Authenticated server request/socket evidence establishes cancellation.
      // Preserve the independent relative node-fs defect; no synthetic marker.
      result.serverObservedCancellation = true
      phase = 'server-marker-read'
      const marker = path.join(root, 'sse-cancelled.txt')
      if (observed.markerWritten === true) {
        const info = await stat(marker); assert.ok(info.isFile() && info.size > 0 && info.size <= 1024)
        const bytes = await readFile(marker); result.serverMarkerBytes = bytes.length
        assert.deepEqual(JSON.parse(bytes.toString()), { event: 'request-aborted', requestAborted: true,
          socketDestroyed: true, responseDestroyed: observed.responseDestroyed })
      } else {
        result.serverMarkerWriteDefect = observed.markerError
        try { const info = await stat(marker); result.serverMarkerFailureStat = { isFile: info.isFile(), bytes: info.size } }
        catch (error) { const code = (error as NodeJS.ErrnoException).code; result.serverMarkerFailureCode = typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'UNKNOWN' }
      }
      phase = 'early-response'
      let uploadCancelled = false
      const upload = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(Buffer.alloc(8192)) }, cancel() { uploadCancelled = true } }, { highWaterMark: 0 })
      const request = new Request(baseUrl + '/early', { method: 'POST', body: upload, duplex: 'half' } as RequestInit)
      const early = await bounded(http.fetch(request), 'windows_http_early_timeout')
      assert.equal(early.status, 413); assert.equal(await bounded(early.text(), 'windows_http_early_body_timeout'), 'early-response')
      assert.equal(uploadCancelled, true); result.earlyResponseUploadSettled = true
      await assert.rejects(bounded(http.fetch('http://127.0.0.1:1/outside-selected-origin'), 'windows_http_outside_origin_unsettled'), error => error instanceof Error && error.message === 'execution_http_transport_unknown')
    }
    phase = 'native-disconnect'
    // Both modes disconnect while a real response consumer is waiting for bytes.
    const response = await bounded(http.fetch(baseUrl + '/disconnect'), 'windows_http_disconnect_setup_timeout')
    const reader = response.body!.getReader()
    const warmup = await bounded(reader.read(), 'windows_http_disconnect_warmup_timeout')
    assert.equal(warmup.done, false, 'windows_http_disconnect_warmup_ended')
    assert.deepEqual(Buffer.from(warmup.value!), Buffer.of(0x71)); result.disconnectWarmupBytes = 1
    const pendingRead = reader.read(); let readSettled = false
    void pendingRead.then(() => { readSettled = true }, () => { readSettled = true })
    await Bun.sleep(0); assert.equal(readSettled, false, 'windows_http_disconnect_read_not_pending')
    result.pendingReadBeforeDisconnect = true
    if (disconnect === 'child-pipe') {
      await broker.request('send', { value: { type: 'testDisconnect', nonce, leaseOwnerId } })
      await until(() => failed)
      assert.equal(failed!.code, 'execution_containment_pipe_denied')
      assert.equal(failed!.clientPID, main.nativePID); assert.deepEqual(failed!.bun, main)
      result.authenticatedFailure = failed
    } else {
      await bounded(broker.close(), 'windows_http_broker_disconnect_timeout', 20000)
      brokerDisconnected = true; assert.equal(helperCloseCode, 0)
      result.nativeWatchdogExitCode = helperCloseCode
    }
    // The actual pending read must receive the original terminal failure;
    // a diagnostic deadline or a later cleanup error cannot establish proof.
    const expectedFailure = disconnect === 'child-pipe' ? 'execution_containment_launcher_denied' : 'execution_containment_helper_closed'
    assert.equal(transportFailure?.message, expectedFailure)
    async function expectRejectedRead(read: ReturnType<typeof reader.read>, name: 'pending' | 'next') {
      let rejected = false, observedError: unknown
      try {
        const observed = await bounded(read, `windows_http_disconnect_${name}_unsettled`)
        result[`${name}ReadOutcome`] = { rejected: false, done: observed.done, bytes: observed.value?.byteLength ?? 0 }
      } catch (error) {
        rejected = true; observedError = error
        const message = error instanceof Error ? error.message : ''
        result[`${name}ReadOutcome`] = { rejected: true, terminalErrorIdentity: error === transportFailure,
          code: /^[a-zA-Z0-9_:.-]{1,160}$/.test(message) ? message : 'windows_http_unknown_error' }
      }
      assert.equal(rejected, true, `windows_http_disconnect_${name}_resolved`)
      assert.equal(observedError, transportFailure, `windows_http_disconnect_${name}_error_mismatch`)
    }
    phase = 'native-disconnect-pending-read'; await expectRejectedRead(pendingRead, 'pending')
    phase = 'native-disconnect-next-read'; await expectRejectedRead(reader.read(), 'next')
    await assert.rejects(bounded(http.fetch(baseUrl + '/get'), 'windows_http_new_request_unsettled'), error => error instanceof Error && error.message === 'execution_http_transport_unknown')
    result.pendingResponseRejected = true; result.terminalErrorIdentityPreserved = true; result.newRequestRejected = true
    if (!brokerDisconnected) {
      const retirement = record(await broker.request('retire'))
      assert.equal(retirement.activeProcesses, 0); assert.equal(retirement.heldProcessExited, true); assert.equal(retirement.ownAcesRemoved, true)
      result.retirement = retirement; retired = true
      assert.deepEqual(await fence.readRecord('owner.json'), ownerRecord)
      result.ownerRecordPreserved = true
    } else {
      // Inspect only: never adopt a serialized process/job or an existing fence.
      const inspection = createWindowsNativeBroker(artifact); inspection.events.on('error', () => {})
      try {
        const after = record(await inspection.request('identity', { pid: main.nativePID }))
        assert.ok(after.absent === true || JSON.stringify(after.birth) !== JSON.stringify(main.birth) || after.exited === true)
        result.mainAfterWatchdogClose = after
        const readonly = await createWindowsOwnerFilesystem(input => inspection.request(input.op, input)).openDirectory(fencePath)
        try { assert.deepEqual(await readonly.readRecord('owner.json'), ownerRecord) } finally { await readonly.close() }
        result.ownerRecordPreserved = true; retired = true
      } finally { await inspection.close() }
    }
    result.frameCounts = frameCounts
  } catch (error) { localFailure = error }
  finally {
    const errors: string[] = []
    // A disconnected HTTP port rejects pending promises; it cannot obtain a
    // remote cancel ACK. Native held Job retirement is the cleanup authority.
    http.fail(new Error('windows_http_probe_closed'))
    if (launched && !brokerDisconnected && !retired) try {
      const receipt = record(await broker.request('retire')); assert.equal(receipt.activeProcesses, 0); assert.equal(receipt.heldProcessExited, true); assert.equal(receipt.ownAcesRemoved, true)
      result.retirement = receipt; retired = true
    } catch { errors.push('native_retirement_unknown') }
    if (sid && (!launched || retired)) try {
      await ps(`$ErrorActionPreference='Stop';$paths=@(Get-Content -LiteralPath $env:TEST_JOURNAL -Raw|ConvertFrom-Json);foreach($p in $paths){$acl=Get-Acl -LiteralPath $p;foreach($rule in @($acl.Access)){if($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value-eq $env:TEST_SID){$acl.RemoveAccessRuleAll($rule)}};Set-Acl -LiteralPath $p -AclObject $acl;$check=Get-Acl -LiteralPath $p;foreach($rule in @($check.Access)){if($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value-eq $env:TEST_SID){throw 'TEST own ACE remains'}}}`, { TEST_SID: sid })
      result.ancestorOwnAcesRemoved = true
    } catch { errors.push('test_ancestor_cleanup_unknown') }
    if (brokerDisconnected && broker.ended() && helperCloseCode === 0) {
      // The native holder exited after verified Scope retirement; its HANDLEs
      // are already closed. No impossible RPC close or serialized adoption.
      handles.length = 0; result.ownerHandlesClosedByNativeHolderExit = true
    } else for (const handle of handles.reverse()) try { await handle.close() } catch { errors.push('native_owner_close_unknown') }
    if (!broker.ended()) try { await broker.close() } catch { errors.push('native_broker_close_unknown') }
    result.helperExitCode = helperCloseCode; result.brokerEnded = broker.ended(); result.cleanupErrors = errors
    result.frameCounts = frameCounts; result.disconnectFrames = disconnectFrames
    result.qualified = localFailure === undefined && errors.length === 0 && retired && broker.ended()
    if (localFailure) {
      result.failedPhase = phase
      const observed = messages.find(value => value.type === 'testSseCancellation'); if (observed) result.serverCancellation = observed
      const marker = path.join(root, 'sse-cancelled.txt')
      try { const info = await stat(marker); result.markerFailureStat = { isFile: info.isFile(), bytes: info.size }; if (info.isFile() && info.size <= 1024) result.markerFailureBytes = await readFile(marker, 'utf8') }
      catch (error) { const code = (error as NodeJS.ErrnoException).code; result.markerFailureCode = typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'UNKNOWN' }
      const message = localFailure instanceof Error ? localFailure.message : ''
      result.failureCode = /^[a-zA-Z0-9_:.-]{1,160}$/.test(message) ? message : 'windows_http_assertion_failed'
    }
    if (!localFailure && errors.length) localFailure = new Error('windows_http_cleanup_unknown')
  }
  if (localFailure) throw localFailure
}
try {
  facts.protocolDisconnectContract = await verifyWindowsHttpDisconnectContract()
  artifact = await resolveWindowsNativeArtifact(); facts.helper = artifact
  const modules = ['OpenCodeV2WindowsHTTP.ts', 'OpenCodeV2WindowsChildControl.ts', 'OpenCodeV2WindowsNativeBroker.ts']
  facts.productionSourceHashes = Object.fromEntries(await Promise.all(modules.map(async name => [name, await digest(path.join(moduleDirectory, name))])))
  facts.productionSourceLfHashes = Object.fromEntries(await Promise.all(modules.map(async name => [name, createHash('sha256').update((await readFile(path.join(moduleDirectory, name), 'utf8')).replace(/\r\n/g, '\n')).digest('hex')])))
  await run('child-pipe'); await run('broker'); facts.qualified = true
}
catch (error) { failure = error }
finally { await writeFile(receiptPath, JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify(facts)) }
if (failure) throw failure
