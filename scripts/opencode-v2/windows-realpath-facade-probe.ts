import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact, resolveWindowsRealpathArtifact } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsOwnerFilesystem.js'

assert.equal(process.platform, 'win32'); assert.equal(process.versions.bun, '1.3.11')
const root = process.argv[2]!, receiptPath = process.argv[3]!
assert.ok(path.win32.isAbsolute(root) && path.win32.isAbsolute(receiptPath))
assert.match(path.basename(root), /^TEST-windows-realpath-[a-zA-Z0-9-]+$/)
const nonce = randomUUID(), leaseOwnerId = randomUUID(), journal = path.join(root, 'ancestor-journal.json'), fencePath = path.join(root, '.native-owner')
const fixture = path.resolve(import.meta.dirname, '../spikes/windows-realpath-facade')
const dllArtifact = await resolveWindowsRealpathArtifact()
const dll = dllArtifact.path
const longTarget = path.join(root, ...Array.from({ length: 3 }, (_, i) => `long-${i}-${'x'.repeat(80)}`), 'leaf.txt')
const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
broker.events.on('error', () => {})
const filesystem = createWindowsOwnerFilesystem(value => broker.request(value.op, value))
const messages: Record<string, unknown>[] = [], handles: WindowsOwnerDirectory[] = []
const facts: Record<string, unknown> = { schema: 1, qualified: false, fullTaskQualified: false, kind: 'native-realpath-facade', ancestorSetupTestOnly: true }
let failure: unknown, stage = 'setup', launched = false, retired = false, sid: string | undefined, peer: Record<string, unknown> | undefined
function record(value: unknown): Record<string, unknown> { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown> }
broker.events.on('message', value => messages.push(record(value)))
broker.events.on('connected', value => { peer = record(value) })
async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 20000
  for (;;) { const value = read(); if (value !== undefined) return value; assert.ok(Date.now() < deadline, `windows_realpath_timeout:${stage}`); await Bun.sleep(10) }
}
const environment: Record<string, string> = {
  SystemRoot: process.env.SystemRoot!, WINDIR: process.env.WINDIR!, LOCALAPPDATA: root,
  PATH: `${root};${path.join(process.env.SystemRoot!, 'System32')}`, USERPROFILE: root, HOME: root, TEMP: root, TMP: root, PWD: root,
  TEST_REALPATH_ROOT: root, TEST_REALPATH_LONG: longTarget,
}
async function ps(script: string) {
  const child = Bun.spawn([path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'pwsh.exe'), '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PSModulePath: path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'Modules'), TEST_ROOT: root, TEST_NONCE: nonce, TEST_JOURNAL: journal, TEST_SID: sid ?? '' }, stdout: 'pipe', stderr: 'pipe',
  })
  const [out, _err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(code, 0, `windows_realpath_test_setup:${stage}`); return out.trim()
}
try {
  const directory = await filesystem.createDirectory(root); await directory.close()
  const fence = await filesystem.createDirectory(fencePath); handles.push(fence)
  await fence.writeExclusive('owner.json', { schema: 1, testOnly: true, nonce, leaseOwnerId })
  await copyFile(process.execPath, path.join(root, 'bun.exe')); await copyFile(dll, path.join(root, 'opencode-v2-windows-realpath.dll'))
  await copyFile(path.join(fixture, 'child.ts'), path.join(root, 'main.ts'))
  await copyFile(path.resolve(import.meta.dirname, '../../src/services/opencode/host/windows/OpenCodeV2WindowsRealpath.ts'), path.join(root, 'facade.ts'))
  await writeFile(path.join(root, 'ordinary.txt'), 'native-realpath-owned-file')
  await mkdir('\\\\?\\' + path.dirname(longTarget), { recursive: true }); await writeFile('\\\\?\\' + longTarget, 'native-realpath-long-file')
  await writeFile(journal, '[]')
  const hashes: Record<string, unknown> = {}
  for (const source of [path.resolve(import.meta.dirname, '../../src/services/opencode/host/windows/WindowsNativeRealpath.hpp'), path.resolve(import.meta.dirname, '../../src/services/opencode/host/windows/WindowsNativeRealpath.cpp'), path.resolve(import.meta.dirname, '../../src/services/opencode/host/windows/OpenCodeV2WindowsRealpath.ts'), path.join(fixture, 'child.ts'), dll]) {
    const bytes = await readFile(source)
    hashes[path.basename(source)] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), lfSha256: source.endsWith('.dll') ? undefined : createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex') }
  }
  assert.equal(record(hashes['OpenCodeV2WindowsRealpath.ts']).lfSha256, '330dd449e130d49d573f32659b68bd2e9f983f54a689516faa17f78a6567b314')
  assert.equal(record(hashes['opencode-v2-windows-realpath.dll']).sha256, dllArtifact.sha256)
  assert.equal(createHash('sha256').update(await readFile(path.join(root, 'opencode-v2-windows-realpath.dll'))).digest('hex'), dllArtifact.sha256)
  facts.inputs = hashes
  stage = 'ordinary-dos-control'
  const ordinary = Bun.spawn([process.execPath, path.join(root, 'main.ts'), 'ordinary'], { cwd: root, env: environment, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(ordinary.stdout).text(), new Response(ordinary.stderr).text(), ordinary.exited])
  facts.ordinaryExit = code; facts.ordinaryDiagnostic = err.slice(0, 2048)
  assert.equal(code, 0); facts.ordinaryControl = record(JSON.parse(out))
  stage = 'test-ancestor-setup'
  sid = await ps(`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class TestAppSid {
[DllImport("userenv.dll",CharSet=CharSet.Unicode)]public static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
[DllImport("advapi32.dll")]public static extern IntPtr FreeSid(IntPtr sid);
}
'@
$native=[IntPtr]::Zero
if([TestAppSid]::DeriveAppContainerSidFromAppContainerName(('AgentTeams.OpenCodeV2.'+$env:TEST_NONCE),[ref]$native)-ne 0){throw 'TEST SID derivation failed'}
try{[System.Security.Principal.SecurityIdentifier]::new($native).Value}finally{[TestAppSid]::FreeSid($native)|Out-Null}
`)
  assert.match(sid, /^S-1-15-2-/)
  await ps(`
$ErrorActionPreference='Stop'
$identity=[System.Security.Principal.SecurityIdentifier]::new($env:TEST_SID)
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($identity,'ReadAndExecute','None','None','Allow')
$planned=[System.Collections.Generic.List[string]]::new();$ancestor=$env:TEST_ROOT
while($ancestor){$planned.Add($ancestor);$parent=[System.IO.DirectoryInfo]::new($ancestor).Parent;if(!$parent){break};$ancestor=$parent.FullName}
[IO.File]::WriteAllText($env:TEST_JOURNAL,(ConvertTo-Json -InputObject @($planned)),[Text.UTF8Encoding]::new($false))
foreach($ancestor in $planned){$acl=Get-Acl -LiteralPath $ancestor;$acl.AddAccessRule($rule);Set-Acl -LiteralPath $ancestor -AclObject $acl}
& icacls.exe ('\\\\?\\'+$env:TEST_ROOT) /setintegritylevel '(OI)(CI)L' /T /Q | Out-Null
if($LASTEXITCODE-ne 0){throw 'TEST low label failed'}
`)
  stage = 'native-main-launch'; launched = true
  const mapping = record(await broker.request('launch', { executable: path.join(root, 'bun.exe'), entry: path.join(root, 'main.ts'), cwd: root, env: environment, writableRoots: [root], readOnlyRoots: [], protectedRoots: [fencePath], nonce, leaseOwnerId }))
  assert.equal(mapping.containerSid, sid)
  const connected = await until(() => peer), main = record(mapping.bun)
  assert.equal(connected.clientPID, main.nativePID); assert.deepEqual(connected.bun, main)
  const { clientPID: _clientPID, ...connectedMapping } = connected; assert.deepEqual(connectedMapping, mapping)
  assert.deepEqual(await broker.request('assertLive'), mapping); facts.mapping = mapping
  const anchors = record(mapping.realpathAnchors); assert.equal(anchors.nonce, nonce)
  assert.equal(anchors.receiptId, `windows-anchors:${record(mapping.supervisor).nativePID}:${main.nativePID}:${record(main.birth).value}`)
  stage = 'native-realpath-facade'
  await broker.request('send', { value: { type: 'prepare', nonce, leaseOwnerId, namespace: mapping.namespace, birth: main.birth, realpathAnchors: anchors } })
  const result = await until(() => messages.find(value => value.type === 'realpathResult' || value.type === 'realpathFailed'))
  facts.childDiagnostics = messages.filter(value => value.type === 'realpathDiagnostic').map(value => {
    assert.equal(value.nonce, nonce); assert.equal(value.leaseOwnerId, leaseOwnerId)
    return record(value.facts)
  })
  assert.ok((facts.childDiagnostics as unknown[]).length <= 1)
  facts.childResult = result
  assert.equal(result.type, 'realpathResult'); assert.equal(result.nonce, nonce); assert.equal(result.leaseOwnerId, leaseOwnerId)
  assert.equal(record(result.result).pid, main.nativePID); assert.equal(record(result.result).creation, record(main.birth).value)
  for (const field of ['sixSurfacesPassed', 'encodingAndFileURLPassed', 'relativePathPassed', 'pendingRetiredPassed', 'detachedRetiredPassed', 'longPathPassed']) assert.equal(record(result.result)[field], true, field)
  facts.genuineDos5MappingPassed = true
} catch (error) { failure = error }
finally {
  facts.failedStage = failure ? stage : undefined
  if (failure) facts.failureCode = failure instanceof Error ? failure.message.slice(0, 240) : 'windows_realpath_unknown'
  const cleanupErrors: string[] = []
  if (launched) try {
    const value = record(await broker.request('retire')); assert.equal(value.activeProcesses, 0); assert.equal(value.heldProcessExited, true); assert.equal(value.ownAcesRemoved, true)
    facts.retirement = value; retired = true
  } catch { cleanupErrors.push('native_scope_retirement_unknown') }
  if (sid && (!launched || retired)) try {
    await ps(`$ErrorActionPreference='Stop';$paths=@(Get-Content -LiteralPath $env:TEST_JOURNAL -Raw|ConvertFrom-Json);foreach($p in $paths){$acl=Get-Acl -LiteralPath $p;foreach($rule in @($acl.Access)){if($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value-eq $env:TEST_SID){$acl.RemoveAccessRuleAll($rule)}};Set-Acl -LiteralPath $p -AclObject $acl;foreach($rule in @((Get-Acl -LiteralPath $p).Access)){if($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value-eq $env:TEST_SID){throw 'TEST own ACE remains'}}}`)
    facts.ancestorOwnAcesRemoved = true
  } catch { cleanupErrors.push('test_ancestor_cleanup_unknown') }
  if (retired) try {
    assert.equal(await readFile(path.join(root, 'ordinary.txt'), 'utf8'), 'native-realpath-owned-file')
    assert.equal(await readFile('\\\\?\\' + longTarget, 'utf8'), 'native-realpath-long-file')
    assert.deepEqual(await handles[0]!.readRecord('owner.json'), { schema: 1, testOnly: true, nonce, leaseOwnerId })
    facts.postRetireHostAndOwnerReadsPassed = true
  } catch { cleanupErrors.push('native_post_retire_reads_failed') }
  for (const handle of handles.reverse()) try { await handle.close() } catch { cleanupErrors.push('native_owner_handle_close_unknown') }
  try { await broker.close() } catch { cleanupErrors.push('native_broker_close_unknown') }
  facts.nativeBrokerEnded = broker.ended(); facts.cleanupErrors = cleanupErrors
  facts.qualified = failure === undefined && cleanupErrors.length === 0 && retired && broker.ended()
  await writeFile(receiptPath, JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify(facts))
  if (!failure && cleanupErrors.length) failure = new Error('windows_realpath_cleanup_unknown')
}
if (failure) throw failure
