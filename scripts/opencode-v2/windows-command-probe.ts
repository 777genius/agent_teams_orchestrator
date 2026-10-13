import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsOwnerFilesystem.js'

// Native mechanism checkpoint only: exact packaged helper, private owned TEST
// tree and builtin-only Bun child. No official server/model/full-team claim.
assert.equal(process.platform, 'win32')
assert.equal(process.versions.bun, '1.3.11')
const root = process.argv[2], receiptPath = process.argv[3]
assert.ok(root && receiptPath && path.win32.isAbsolute(root) && path.win32.isAbsolute(receiptPath))
assert.match(path.win32.basename(root), /^TEST-windows-command-[a-zA-Z0-9-]+$/)
const nonce = randomUUID(), leaseOwnerId = randomUUID(), journal = path.join(root, 'ancestor-journal.json')
const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
broker.events.on('error', () => {})
const filesystem = createWindowsOwnerFilesystem(value => broker.request(value.op, value))
const handles: WindowsOwnerDirectory[] = []
const facts: Record<string, unknown> = { schema: 1, qualified: false, fullTaskQualified: false, kind: 'native-command-mechanisms', nonce }
let failure: unknown, stage = 'setup', launched = false, retired = false, sid: string | undefined
const powershell = path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'pwsh.exe')
async function ps(script: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([powershell, '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PSModulePath: path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'Modules'), TEST_ROOT: root, TEST_NONCE: nonce, TEST_JOURNAL: journal, ...extra }, stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`windows_command_setup_failed:${code}:${err.slice(-2048)}`)
  return out.trim()
}
function record(value: unknown): Record<string, unknown> { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown> }
const messages: Record<string, unknown>[] = []
broker.events.on('message', value => messages.push(record(value)))
async function until<T>(read: () => T | undefined, milliseconds = 10000): Promise<T> {
  const end = Date.now() + milliseconds
  for (;;) { const result = read(); if (result !== undefined) return result; assert.ok(Date.now() < end, `windows_command_timeout:${stage}`); await Bun.sleep(10) }
}
async function output(commandId: string, stream: 'stdout' | 'stderr') {
  let offset = 0; const chunks: Buffer[] = []
  for (;;) {
    const value = record(await broker.request('commandRead', { commandId, stream, offset, maxBytes: 8192 }))
    assert.equal(typeof value.bytesBase64, 'string')
    const bytes = Buffer.from(String(value.bytesBase64), 'base64')
    assert.equal(bytes.toString('base64'), value.bytesBase64); assert.ok(bytes.length <= 8192)
    assert.equal(value.nextOffset, offset + bytes.length); offset += bytes.length; assert.ok(offset <= 8 * 1024 * 1024)
    chunks.push(bytes)
    if (value.eof === true) return Buffer.concat(chunks)
    assert.equal(value.eof, false); await Bun.sleep(10)
  }
}
const activeCommands = new Set<string>()
async function start(script: string, stdin: 'ignore' | 'pipe') {
  const commandId = randomUUID()
  const value = record(await broker.request('commandStart', { commandId, executable: path.join(root, 'bun.exe'), args: [script], cwd: root, env: environment, stdin }))
  activeCommands.add(commandId)
  assert.equal(value.commandId, commandId); assert.ok(Number.isSafeInteger(value.pid) && Number(value.pid) > 0)
  assert.match(String(value.birthFiletime), /^[1-9]\d{0,19}$/)
  return { commandId, pid: Number(value.pid), birthFiletime: String(value.birthFiletime) }
}
async function closeCommand(commandId: string) {
  const value = record(await broker.request('commandRetire', { commandId }))
  assert.equal(value.empty, true); assert.equal(value.activeProcesses, 0); assert.equal(value.heldProcessExited, true)
  const closed = record(await broker.request('commandClose', { commandId })); assert.equal(closed.closed, true)
  activeCommands.delete(commandId); return value
}
const environment: Record<string, string> = {
  SystemRoot: process.env.SystemRoot!, WINDIR: process.env.WINDIR!, LOCALAPPDATA: root,
  PATH: `${root};${path.join(process.env.SystemRoot!, 'System32')}`, USERPROFILE: root, HOME: root, TEMP: root, TMP: root, PWD: root,
}
try {
  const parent = await filesystem.createDirectory(root); await parent.close()
  const fencePath = path.join(root, '.native-owner')
  const fence = await filesystem.createDirectory(fencePath); handles.push(fence)
  await fence.writeExclusive('owner.json', { schema: 1, testOnly: true, nonce, leaseOwnerId })
  await copyFile(process.execPath, path.join(root, 'bun.exe'))
  await writeFile(path.join(root, 'main.ts'), `
import net from 'node:net'
const nonce=process.env.OPENCODE_V2_WINDOWS_NONCE,leaseOwnerId=process.env.OPENCODE_V2_WINDOWS_LEASE
const socket=net.createConnection(process.env.OPENCODE_V2_WINDOWS_PIPE!)
let buffer='',prepared:any
const send=(value:any)=>socket.write(JSON.stringify({...value,nonce,leaseOwnerId})+'\\n')
socket.on('error',()=>process.exit(9));socket.on('close',()=>process.exit(0))
socket.on('data',part=>{buffer+=part.toString();while(buffer.includes('\\n')){const end=buffer.indexOf('\\n'),message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1)
if(message.nonce!==nonce||message.leaseOwnerId!==leaseOwnerId)process.exit(10)
if(message.type==='prepare'){prepared=message;send({...message,type:'prepared',pid:process.pid})}
if(message.type==='close'){send({type:'closed',pid:process.pid,birth:prepared.birth,namespace:prepared.namespace,scopeClosed:true});socket.end()}
}})
`)
  await writeFile(path.join(root, 'output.ts'), `await Bun.write('actual-command.txt','native-command-written');await Bun.stdout.write(new TextEncoder().encode('native-output-é'));await Bun.stderr.write('native-error-marker')`)
  await writeFile(path.join(root, 'echo.ts'), `for await(const bytes of Bun.stdin.stream())await Bun.stdout.write(bytes);await Bun.stderr.write('stdin-eof-observed')`)
  await writeFile(path.join(root, 'grandchild.ts'), `await Bun.write('grandchild-live.txt',String(process.pid));setInterval(()=>{},1000)`)
  await writeFile(path.join(root, 'cancel.ts'), `const child=Bun.spawn([process.execPath,'grandchild.ts'],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});await Bun.write('cancel-child.txt',String(child.pid));setInterval(()=>{},1000)`)
  await writeFile(journal, '[]')
  stage = 'test-ancestor-setup'
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
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),'ReadAndExecute','None','None','Allow')
$planned=[System.Collections.Generic.List[string]]::new();$ancestor=$env:TEST_ROOT
while($ancestor){$planned.Add($ancestor);$info=[System.IO.DirectoryInfo]::new($ancestor).Parent;if(!$info){break};$ancestor=$info.FullName}
[IO.File]::WriteAllText($env:TEST_JOURNAL,(ConvertTo-Json -InputObject @($planned)),[Text.UTF8Encoding]::new($false))
foreach($ancestor in $planned){$acl=Get-Acl -LiteralPath $ancestor;$acl.AddAccessRule($rule);Set-Acl -LiteralPath $ancestor -AclObject $acl}
& icacls.exe $env:TEST_ROOT /setintegritylevel '(OI)(CI)L' /T /Q | Out-Null
if($LASTEXITCODE-ne 0){throw 'TEST low label failed'}
$sid
`)
  assert.match(sid, /^S-1-15-2-/)
  stage = 'native-main-launch'; launched = true
  await fence.assertOwned()
  const mapping = record(await broker.request('launch', { executable: path.join(root, 'bun.exe'), entry: path.join(root, 'main.ts'), cwd: root, env: environment, writableRoots: [root], readOnlyRoots: [], protectedRoots: [fencePath], nonce, leaseOwnerId }))
  assert.equal(mapping.containerSid, sid)
  const main = record(mapping.bun)
  const connected = await until(() => messages.find(value => value.type === 'prepared'))
  // Preparation is sent only once the native pipe reports its held main PID.
  // Native event listener below measures that peer rather than a caller flag.
  assert.equal(connected.pid, main.nativePID)
  stage = 'native-file-output'
  const command = await start(path.join(root, 'output.ts'), 'ignore')
  const [stdout, stderr] = await Promise.all([output(command.commandId, 'stdout'), output(command.commandId, 'stderr')])
  assert.equal(stdout.toString(), 'native-output-é'); assert.equal(stderr.toString(), 'native-error-marker')
  assert.equal(await readFile(path.join(root, 'actual-command.txt'), 'utf8'), 'native-command-written')
  facts.outputCommand = command; await closeCommand(command.commandId)
  stage = 'native-stdin-echo'
  const echo = await start(path.join(root, 'echo.ts'), 'pipe'), expected = Buffer.alloc(23000)
  for (let i = 0; i < expected.length; i++) expected[i] = i % 251
  let offset = 0
  while (offset < expected.length) {
    const bytes = expected.subarray(offset, offset + 8192)
    const ack = record(await broker.request('commandWriteStdin', { commandId: echo.commandId, offset, bytesBase64: bytes.toString('base64') }))
    assert.ok(Number.isSafeInteger(ack.writtenBytes) && Number(ack.writtenBytes) > 0 && Number(ack.writtenBytes) <= bytes.length)
    assert.equal(ack.nextOffset, offset + Number(ack.writtenBytes)); offset = Number(ack.nextOffset)
  }
  const eof = record(await broker.request('commandEndStdin', { commandId: echo.commandId, offset }))
  assert.equal(eof.closed, true); assert.equal(eof.nextOffset, expected.length)
  const [echoBytes, echoError] = await Promise.all([output(echo.commandId, 'stdout'), output(echo.commandId, 'stderr')])
  assert.deepEqual(echoBytes, expected); assert.equal(echoError.toString(), 'stdin-eof-observed')
  facts.stdinCommand = echo; facts.stdinBytes = offset; await closeCommand(echo.commandId)
  stage = 'native-descendant-cancel'
  const cancellation = await start(path.join(root, 'cancel.ts'), 'ignore')
  await until(() => { try { return Bun.file(path.join(root, 'grandchild-live.txt')).size > 0 ? true : undefined } catch { return undefined } })
  const live = record(await broker.request('commandStatus', { commandId: cancellation.commandId }))
  assert.equal(live.running, true); assert.ok(Number(live.activeProcesses) >= 2)
  const descendantPID = Number(await readFile(path.join(root, 'grandchild-live.txt'), 'utf8'))
  assert.ok(Number.isSafeInteger(descendantPID) && descendantPID > 0)
  const descendantBirth = record(await broker.request('identity', { pid: descendantPID }))
  facts.cancelCommand = cancellation; facts.descendant = descendantBirth; facts.activeBeforeCancel = live.activeProcesses
  await closeCommand(cancellation.commandId)
  const after = record(await broker.request('identity', { pid: descendantPID })); assert.equal(after.absent, true)
  facts.fileOutputPassed = true; facts.stdinEchoEofPassed = true; facts.descendantCancelPassed = true
} catch (error) { failure = error }
finally {
  facts.failedStage = failure ? stage : undefined
  const cleanupErrors: string[] = []
  if (launched) {
    try {
      const receipt = record(await broker.request('retire')); assert.equal(receipt.activeProcesses, 0); assert.equal(receipt.heldProcessExited, true); assert.equal(receipt.ownAcesRemoved, true)
      facts.retirement = receipt; retired = true
    } catch { cleanupErrors.push('native_scope_retirement_unknown') }
  }
  if (sid && (!launched || retired)) {
    try {
      await ps(`$ErrorActionPreference='Stop';$paths=@(Get-Content -LiteralPath $env:TEST_JOURNAL -Raw|ConvertFrom-Json);foreach($p in $paths){$acl=Get-Acl -LiteralPath $p;foreach($rule in @($acl.Access)){if($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value-eq $env:TEST_SID){$acl.RemoveAccessRuleAll($rule)}};Set-Acl -LiteralPath $p -AclObject $acl;$check=Get-Acl -LiteralPath $p;foreach($rule in @($check.Access)){if($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value-eq $env:TEST_SID){throw 'TEST own ACE remains'}}}`, { TEST_SID: sid })
      facts.ancestorOwnAcesRemoved = true
    } catch { cleanupErrors.push('test_ancestor_cleanup_unknown') }
  }
  for (const handle of handles.reverse()) try { await handle.close() } catch { cleanupErrors.push('native_owner_handle_close_unknown') }
  try { await broker.close() } catch { cleanupErrors.push('native_broker_close_unknown') }
  facts.nativeBrokerEnded = broker.ended(); facts.cleanupErrors = cleanupErrors
  facts.qualified = failure === undefined && cleanupErrors.length === 0 && broker.ended() && retired
  await writeFile(receiptPath, JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify(facts))
  if (!failure && cleanupErrors.length) failure = new Error('windows_command_cleanup_unknown')
}
if (failure) throw failure
