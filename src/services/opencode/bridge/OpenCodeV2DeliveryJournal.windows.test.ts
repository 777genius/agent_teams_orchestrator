import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { link, lstat, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../host/windows/OpenCodeV2WindowsOwnerFilesystem.js'
import type { SendMessageOutcomeBase } from './OpenCodeBridgeDeliveryJournal.js'
import { OpenCodeV2DeliveryJournal } from './OpenCodeV2DeliveryJournal.js'
import { openWindowsDeliveryJournalGuard } from './OpenCodeV2WindowsDeliveryGuard.js'

// This exercises only the real app journal in a fresh native-private TEST root.
// There is no run owner, session, prompt, model, or synthetic qualification.
test.skipIf(process.platform !== 'win32')('Windows delivery journal reserves one original app submission before native send', async () => {
  const deadline = Date.now() + 30_000
  const root = path.join(await realpath(os.tmpdir()), `TEST-v2-delivery-journal-${randomUUID()}`)
  const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
  broker.events.on('error', () => {})
  const filesystem = createWindowsOwnerFilesystem((request, requestDeadline, signal) =>
    broker.request(request.op, request, requestDeadline, signal))
  let held: WindowsOwnerDirectory | undefined
  let phase: 'private-root' | 'reserve' | 'fresh-observe' = 'private-root'
  try {
    held = await filesystem.prepareDirectory(root, true, deadline)
    await held.assertOwned(deadline)
    const identity = { requestId: 'TEST-request', deliveryAttemptId: 'TEST-attempt',
      localMessageId: 'TEST-message', nativeInputID: 'msg_TESTjournal' }
    const base: SendMessageOutcomeBase = { requestId: identity.requestId, teamId: 'TEST-team', teamName: 'TEST-team',
      runId: 'TEST-run', laneId: 'TEST-lane', memberName: 'TEST-worker', projectPath: root,
      body: { deliveryAttemptId: identity.deliveryAttemptId, messageId: identity.localMessageId, payloadHash: 'a'.repeat(64) } }
    const journal = new OpenCodeV2DeliveryJournal(root)
    const intentHash = executionHash({ identity, delivery: 'queue',
      input: { nativeInputID: identity.nativeInputID, text: 'TEST journal only; never submitted', resume: true } })
    phase = 'reserve'
    const original = await journal.reserve(base, 'ses_TESTjournal', identity, intentHash, deadline)
    expect(original.action).toBe('submit')
    expect(original.submissionOwner).toMatch(/^[a-f0-9-]{36}$/)
    expect((await journal.query({ requestId: identity.requestId })).record).toMatchObject({
      status: 'prompt_submitting', safeToRetry: false, runtimePromptMessageId: identity.nativeInputID,
      sessionId: 'ses_TESTjournal' })
    phase = 'fresh-observe'
    expect(await new OpenCodeV2DeliveryJournal(root).reserve(base, 'ses_TESTjournal', identity, intentHash, deadline))
      .toEqual({ action: 'observe', submissionOwner: original.submissionOwner })
    await held.assertOwned(deadline)
  } catch (error) {
    const guard = await lstat(path.join(root, 'opencode', 'command-outcomes.v2-observation.lock')).catch(() => null)
    console.error(JSON.stringify({ event: 'TEST_windows_delivery_journal_failure', phase,
      code: error instanceof Error && error.message === 'delivery_lock_foreign' ? 'delivery_lock_foreign' : 'unknown',
      getuidAvailable: typeof process.getuid === 'function',
      guardRegular: guard?.isFile() === true && !guard.isSymbolicLink(), guardSingleLink: guard?.nlink === 1,
      posixOwnerMatches: guard !== null && guard.uid === process.getuid?.(),
      posixModePrivate: guard !== null && (guard.mode & 0o077) === 0 }))
    throw error
  } finally {
    try { await held?.close() } finally { await broker.close() }
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

// Target-only TEST security fixtures. The captured complete descriptor is
// restored exactly; no parent/child inheritance or user ACL is changed.
const fixtureSecurity = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class TestDeliverySecurity {
public static string Step = "unknown";
[DllImport("advapi32.dll",EntryPoint="GetFileSecurityW",ExactSpelling=true,CharSet=CharSet.Unicode,SetLastError=true)]
[return:MarshalAs(UnmanagedType.Bool)] static extern bool GetFileSecurity(string p,uint i,[Out] byte[] b,uint n,out uint needed);
[DllImport("advapi32.dll",EntryPoint="SetFileSecurityW",ExactSpelling=true,CharSet=CharSet.Unicode,SetLastError=true)]
[return:MarshalAs(UnmanagedType.Bool)] static extern bool SetFileSecurity(string p,uint i,byte[] b);
[DllImport("advapi32.dll",ExactSpelling=true,SetLastError=true)]
[return:MarshalAs(UnmanagedType.Bool)] static extern bool GetSecurityDescriptorControl(byte[] b,out ushort c,out uint r);
[DllImport("advapi32.dll",ExactSpelling=true,SetLastError=true)]
[return:MarshalAs(UnmanagedType.Bool)] static extern bool SetSecurityDescriptorControl([In,Out] byte[] b,ushort mask,ushort bits);
public static byte[] Read(string p) {
Step="read_size"; uint n;
bool result=GetFileSecurity(p,5,null,0,out n);int error=Marshal.GetLastWin32Error();
if(!result&&error!=122)throw new System.ComponentModel.Win32Exception(error);
if(result||n==0||n>131072)throw new InvalidOperationException("TEST_descriptor_size_changed");
Step="read_descriptor";var b=new byte[(int)n];uint actual;
if(!GetFileSecurity(p,5,b,n,out actual))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
if(actual!=n)throw new InvalidOperationException("TEST_descriptor_size_changed");return b;
}
public static void Write(string p,byte[] original,uint sections) {
var b=(byte[])original.Clone();ushort c;uint r;Step="read_control";
if(!GetSecurityDescriptorControl(b,out c,out r))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
Step="write_control";
if((sections&4)!=0&&(c&0x400)!=0&&!SetSecurityDescriptorControl(b,0x100,0x100))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
Step="write_descriptor";
if(!SetFileSecurity(p,sections,b))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
}
}
'@
`

async function securityFixture(target: string, mode: 'foreign-ace' | 'unprotected' | 'foreign-owner',
  deadline: number, verify: () => Promise<void>): Promise<void> {
  const execute = async (phase: 'install' | 'restore', script: string, extra: Record<string, string> = {}) => {
    const budget = Math.min(10_000, deadline - Date.now())
    expect(budget).toBeGreaterThan(0)
    // A single encoded UTF-16LE argument preserves the exact C#/PowerShell
    // source across Bun's Windows argv quoting; Stop includes Add-Type failures.
    const command = `
$ErrorActionPreference='Stop'
$fixtureStep='add_type';$primaryFailure=$null;$primaryStep=$null;$primaryNativeStep=$null;$rollbackFailed=$false
try {
${fixtureSecurity}
${script}
} catch {
$failure=if($null -ne $primaryFailure){$primaryFailure}else{$_}
$step=if($null -ne $primaryStep){$primaryStep}else{$fixtureStep}
if($step -in @('read_original','write_mutation','write_restore','read_restored')){
$step=if($null -ne $primaryNativeStep){$primaryNativeStep}else{[TestDeliverySecurity]::Step}}
$steps=@('add_type','read_original','acl_read','rule_construct','verify_mutation','write_mutation','write_restore','read_restored','read_size','read_descriptor','read_control','write_control','write_descriptor')
if($step -notin $steps){$step='unknown'}
$types=@('System.Management.Automation.MethodInvocationException','System.Management.Automation.RuntimeException','System.Management.Automation.PSInvalidOperationException','System.EntryPointNotFoundException','System.DllNotFoundException','System.ComponentModel.Win32Exception','System.UnauthorizedAccessException','System.Security.SecurityException','System.ArgumentException','System.InvalidOperationException')
$exceptionType='unknown';$nativeCode=$null;$exception=$failure.Exception
for($i=0;$i -lt 4 -and $null -ne $exception;$i++){
$name=$exception.GetType().FullName;if($name -in $types){$exceptionType=$name}
if($exception -is [System.ComponentModel.Win32Exception]){$nativeCode=[long]$exception.NativeErrorCode}
$exception=$exception.InnerException}
$ids=@('COMPILER_ERRORS','SOURCE_CODE_ERROR','TYPE_ALREADY_EXISTS','TypeNotFound','MethodNotFound','MethodInvocationException','Exception','ArgumentException','UnauthorizedAccessException','TEST_fixture_mutation_missing')
$id=if(([string]$failure.FullyQualifiedErrorId).Length -le 256){([string]$failure.FullyQualifiedErrorId).Split(',')[0]}else{'unknown'}
$errorId=if($id -in $ids){$id}else{'unknown'}
$facts=@{step=$step;exceptionType=$exceptionType;errorId=$errorId;rollbackFailed=[bool]$rollbackFailed}
if($null -ne $nativeCode -and $nativeCode -ge 0 -and $nativeCode -le 4294967295){$facts.nativeCode=$nativeCode}
[Console]::Out.Write('TEST_SECURITY_FAILURE:'+($facts|ConvertTo-Json -Compress));throw
}`
    const child = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      env: { ...process.env, TEST_TARGET: target, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: budget,
    })
    const stderr = (async () => {
      const chunks: Uint8Array[] = []; let retained = 0
      for await (const chunk of child.stderr) {
        const part = chunk.subarray(0, Math.max(0, 65_536 - retained))
        if (part.length) { chunks.push(part); retained += part.length }
      }
      return Buffer.concat(chunks).toString('utf8')
    })()
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), stderr])
    if (code !== 0) {
      let facts: Record<string, unknown> = {}
      if (stdout.startsWith('TEST_SECURITY_FAILURE:') && stdout.length <= 4096) {
        try { facts = executionRecord(JSON.parse(stdout.slice('TEST_SECURITY_FAILURE:'.length))) } catch { /* Closed unknowns below. */ }
      }
      const steps = ['add_type', 'read_original', 'acl_read', 'rule_construct', 'verify_mutation', 'write_mutation', 'write_restore',
        'read_restored', 'read_size', 'read_descriptor', 'read_control', 'write_control', 'write_descriptor']
      const types = ['System.Management.Automation.MethodInvocationException', 'System.Management.Automation.RuntimeException',
        'System.Management.Automation.PSInvalidOperationException', 'System.EntryPointNotFoundException', 'System.DllNotFoundException',
        'System.ComponentModel.Win32Exception', 'System.UnauthorizedAccessException', 'System.Security.SecurityException',
        'System.ArgumentException', 'System.InvalidOperationException']
      const ids = ['COMPILER_ERRORS', 'SOURCE_CODE_ERROR', 'TYPE_ALREADY_EXISTS', 'TypeNotFound', 'MethodNotFound',
        'MethodInvocationException', 'Exception', 'ArgumentException', 'UnauthorizedAccessException', 'TEST_fixture_mutation_missing']
      console.error(JSON.stringify({ event: 'TEST_windows_journal_security_fixture_failed', phase, mode,
        targetKind: path.basename(target) === 'owner.lock' ? 'guard' : 'leaf',
        ...(typeof facts.rollbackFailed === 'boolean' ? { rollbackFailed: facts.rollbackFailed } : {}),
        step: typeof facts.step === 'string' && steps.includes(facts.step) ? facts.step : 'unknown',
        exceptionType: typeof facts.exceptionType === 'string' && types.includes(facts.exceptionType) ? facts.exceptionType : 'unknown',
        errorId: typeof facts.errorId === 'string' && ids.includes(facts.errorId) ? facts.errorId : 'unknown',
        ...(Number.isSafeInteger(facts.nativeCode) && Number(facts.nativeCode) >= 0 && Number(facts.nativeCode) <= 0xffffffff
          ? { nativeCode: Number(facts.nativeCode) } : {}) }))
    }
    expect(code).toBe(0) // Raw PowerShell messages, paths and descriptors stay private.
    return stdout.trim()
  }
  const original = await execute('install', `
$fixtureStep='read_original';$original=[TestDeliverySecurity]::Read($env:TEST_TARGET)
$sections=if($env:TEST_MODE -eq 'foreign-owner'){1}else{4}
try{
$fixtureStep='acl_read';$acl=Get-Acl -LiteralPath $env:TEST_TARGET
$fixtureStep='rule_construct';switch($env:TEST_MODE){
'foreign-ace'{$rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','None','None','Allow');$expectedMask=[long]$rule.FileSystemRights;$acl.AddAccessRule($rule)}
'unprotected'{$acl.SetAccessRuleProtection($false,$false)}
'foreign-owner'{$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))}
}
$fixtureStep='write_mutation';[TestDeliverySecurity]::Write($env:TEST_TARGET,$acl.GetSecurityDescriptorBinaryForm(),$sections)
$fixtureStep='verify_mutation';$installed=[Security.AccessControl.RawSecurityDescriptor]::new([TestDeliverySecurity]::Read($env:TEST_TARGET),0)
$matches=switch($env:TEST_MODE){
'foreign-ace'{@($installed.DiscretionaryAcl|Where-Object{$_.AceType -eq 'AccessAllowed' -and $_.SecurityIdentifier.Value -eq 'S-1-1-0' -and [long]$_.AccessMask -eq $expectedMask -and [int]$_.AceFlags -eq 0}).Count -eq 1}
'unprotected'{([int]$installed.ControlFlags -band 0x1000) -eq 0}
'foreign-owner'{$installed.Owner.Value -eq 'S-1-5-32-544'}
}
if(!$matches){throw [InvalidOperationException]::new('TEST_fixture_mutation_missing')}
[Console]::Write([Convert]::ToBase64String($original))
}catch{
$primaryFailure=$_;$primaryStep=$fixtureStep;$primaryNativeStep=[TestDeliverySecurity]::Step
try{
$fixtureStep='write_restore';[TestDeliverySecurity]::Write($env:TEST_TARGET,$original,$sections)
$fixtureStep='read_restored';$restored=[TestDeliverySecurity]::Read($env:TEST_TARGET)
if([Convert]::ToBase64String($restored) -ne [Convert]::ToBase64String($original)){throw [InvalidOperationException]::new('TEST_fixture_restore_changed')}
}catch{$rollbackFailed=$true}
throw $primaryFailure
}
`, { TEST_MODE: mode })
  let primary: unknown
  try { await verify() } catch (error) { primary = error; throw error }
  finally {
    try {
      expect(await execute('restore', `
$sections=if($env:TEST_MODE -eq 'foreign-owner'){1}else{4}
$fixtureStep='write_restore';[TestDeliverySecurity]::Write($env:TEST_TARGET,[Convert]::FromBase64String($env:TEST_DESCRIPTOR),$sections)
$fixtureStep='read_restored';[Console]::Write([Convert]::ToBase64String([TestDeliverySecurity]::Read($env:TEST_TARGET)))
`, { TEST_MODE: mode, TEST_DESCRIPTOR: original }) === original).toBe(true)
    } catch (error) {
      if (primary !== undefined) throw new AggregateError([primary, error], 'TEST_journal_fixture_restore_failed')
      throw error
    }
  }
}

test.skipIf(process.platform !== 'win32')('Windows delivery guard holds exact private files and refuses foreign or substituted custody', async () => {
  const deadline = Date.now() + 90_000
  const cutoff = () => Math.min(deadline, Date.now() + 30_000)
  const root = path.join(await realpath(os.tmpdir()), `TEST-v2-delivery-guard-${randomUUID()}`)
  const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact(cutoff()))
  broker.events.on('error', () => {})
  const filesystem = createWindowsOwnerFilesystem((request, requestDeadline, signal) =>
    broker.request(request.op, request, requestDeadline, signal))
  let held: WindowsOwnerDirectory | undefined
  let guard: Awaited<ReturnType<typeof openWindowsDeliveryJournalGuard>> | undefined
  try {
    held = await filesystem.prepareDirectory(root, true, cutoff())
    guard = await openWindowsDeliveryJournalGuard(root, cutoff())
    const directory = path.dirname(guard.path), originalFile = path.join(root, 'TEST-original-guard')
    const initial = await lstat(guard.path)
    const peer = await openWindowsDeliveryJournalGuard(root, cutoff())
    try {
      await expect(rename(guard.path, originalFile)).rejects.toBeDefined()
      await expect(rename(directory, path.join(root, 'TEST-moved-directory'))).rejects.toBeDefined()
      await guard.assertOwned(); await peer.assertOwned()
      expect((await lstat(guard.path)).ino).toBe(initial.ino)
    } finally { await peer.close() }
    const identity = { requestId: 'TEST-concurrent-request', deliveryAttemptId: 'TEST-concurrent-attempt',
      localMessageId: 'TEST-concurrent-message', nativeInputID: 'msg_TESTconcurrentjournal' }
    const base: SendMessageOutcomeBase = { requestId: identity.requestId, teamId: 'TEST-team', teamName: 'TEST-team',
      runId: 'TEST-run', laneId: 'TEST-lane', memberName: 'TEST-worker', projectPath: root,
      body: { deliveryAttemptId: identity.deliveryAttemptId, messageId: identity.localMessageId, payloadHash: 'a'.repeat(64) } }
    const transactionDeadline = cutoff()
    const decisions = await Promise.all([new OpenCodeV2DeliveryJournal(root).reserve(base, 'ses_TESTjournal', identity, 'b'.repeat(64), transactionDeadline),
      new OpenCodeV2DeliveryJournal(root).reserve(base, 'ses_TESTjournal', identity, 'b'.repeat(64), transactionDeadline)])
    expect(decisions.map(value => value.action).sort()).toEqual(['observe', 'submit'])
    expect(decisions[0]!.submissionOwner).toBe(decisions[1]!.submissionOwner)
    const outcomePath = path.join(root, 'opencode', 'command-outcomes.json')
    const originalOutcome = await readFile(outcomePath)
    // An existing pinned guard cannot change trustee, protection, or owner.
    for (const mode of ['foreign-ace', 'unprotected', 'foreign-owner'] as const) {
      await securityFixture(guard.path, mode, deadline, async () => {
        await expect(guard!.assertOwned()).rejects.toThrow('execution_owner_not_private')
      })
      await guard.assertOwned()
    }
    await guard.close(); guard = undefined
    for (const target of [directory, path.join(directory, 'owner.lock')]) {
      for (const mode of ['foreign-ace', 'unprotected', 'foreign-owner'] as const) {
        await securityFixture(target, mode, deadline, async () => {
          await expect(openWindowsDeliveryJournalGuard(root, cutoff())).rejects.toThrow('execution_owner_not_private')
        })
      }
    }
    await writeFile(path.join(directory, 'owner.lock'), 'TEST nonempty guard')
    try { await expect(openWindowsDeliveryJournalGuard(root, cutoff())).rejects.toThrow('execution_owner_metadata_budget') }
    finally { await writeFile(path.join(directory, 'owner.lock'), '') }
    const hardlink = path.join(root, 'TEST-hardlink')
    await link(path.join(directory, 'owner.lock'), hardlink)
    try { await expect(openWindowsDeliveryJournalGuard(root, cutoff())).rejects.toThrow('execution_owner_alias') }
    finally { await unlink(hardlink) }
    const sentinel = path.join(root, 'TEST-sentinel')
    await writeFile(sentinel, 'TEST sentinel survives', { flag: 'wx' })
    await rename(path.join(directory, 'owner.lock'), originalFile)
    await symlink(sentinel, path.join(directory, 'owner.lock'), 'file')
    try { await expect(openWindowsDeliveryJournalGuard(root, cutoff())).rejects.toThrow('execution_owner_alias') }
    finally { await unlink(path.join(directory, 'owner.lock')); await rename(originalFile, path.join(directory, 'owner.lock')) }
    expect(await readFile(sentinel, 'utf8')).toBe('TEST sentinel survives')
    const originalDirectory = path.join(root, 'TEST-original-directory')
    await rename(directory, originalDirectory)
    await symlink(originalDirectory, directory, 'junction')
    try { await expect(openWindowsDeliveryJournalGuard(root, cutoff())).rejects.toThrow('delivery_root_invalid') }
    finally { await unlink(directory); await rename(originalDirectory, directory) }
    guard = await openWindowsDeliveryJournalGuard(root, cutoff())
    await guard.assertOwned()
    const leaf = await filesystem.prepareDirectory(directory, false, cutoff())
    try {
      await expect(leaf.readMetadata('DeliveryGuard', cutoff())).rejects.toThrow('execution_owner_metadata_missing')
      await expect(leaf.writeMetadata('DeliveryGuard', {}, cutoff())).rejects.toThrow('execution_owner_unknown')
    } finally { await leaf.close() }
    const rawLeaf = executionRecord(await broker.request('ownerPreparePrivateDirectory',
      { path: directory, createExclusive: false }, cutoff()))
    expect(typeof rawLeaf.handleId).toBe('string')
    try {
      await expect(broker.request('ownerWriteMetadata', { op: 'ownerWriteMetadata', purpose: 'DeliveryGuard',
        handleId: rawLeaf.handleId, bytesBase64: Buffer.from('TEST').toString('base64') }, cutoff()))
        .rejects.toThrow('execution_owner_metadata_budget')
      await expect(broker.request('ownerWriteMetadata', { op: 'ownerWriteMetadata', purpose: 'DeliveryGuard',
        handleId: rawLeaf.handleId, bytesBase64: '', name: 'TEST-arbitrary-file' }, cutoff()))
        .rejects.toThrow('execution_invalid_response')
    } finally { await broker.request('ownerCloseDirectory', { handleId: rawLeaf.handleId }, cutoff()) }
    await expect(held.writeMetadata('DeliveryGuard', null, cutoff())).rejects.toThrow('execution_owner_metadata_purpose_invalid')
    expect((await readFile(outcomePath)).equals(originalOutcome)).toBe(true)
  } finally {
    try { await guard?.close() } finally {
      try { await held?.close() } finally { await broker.close() }
    }
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
