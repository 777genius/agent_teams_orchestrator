import { openCodeBunVersion } from '../../src/constants/openCodeBunVersion.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsOwnerFilesystem.js'
import { executionHash, executionRecord } from '../../src/services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import { prepareWindowsPrivateDirectories } from '../../src/services/opencode/profile/OpenCodePrivateDirectories.js'
import { runControlDirectory } from '../../src/services/opencode/bridge/OpenCodeV2RunControl.js'

// Actual native helper only. Supply a NEW TEST directory under the CI scratch
// root. Retain its fences/records after both success and failure; no adoption,
// deletion, native model, provider, credential or user-project effects.
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert.equal(process.versions.bun, openCodeBunVersion())
const requestedRoot = process.argv[2]
assert.ok(requestedRoot && path.win32.isAbsolute(requestedRoot))
assert.match(path.win32.basename(requestedRoot), /^TEST-windows-owner-[a-zA-Z0-9-]+$/)
const facts: Record<string, unknown> = { schema: 1, qualified: false, primitive: 'held-directory-rename', runRoot: requestedRoot }
const producerPath = path.resolve(import.meta.dir, '../../native/win32-x64/opencode-v2-windows-helper.exe')
const imageSnapshot = async (file: string) => {
  const info = await lstat(file)
  assert.equal(info.isFile(), true); assert.equal(info.isSymbolicLink(), false); assert.equal(info.nlink, 1)
  return { dev: info.dev, ino: info.ino, birth: info.birthtimeMs, mtime: info.mtimeMs,
    size: info.size, sha256: createHash('sha256').update(await readFile(file)).digest('hex') }
}
const producerBefore = await imageSnapshot(producerPath)
const helper = await resolveWindowsNativeArtifact()
const broker = createWindowsNativeBroker(helper)
broker.events.on('error', () => {})
const request = (operation: string, input: Readonly<Record<string, unknown>>) => {
  facts.lastOperation = operation
  delete facts.lastRelativePath
  const target = typeof input.path === 'string' ? input.path : typeof input.root === 'string' ? input.root : undefined
  if (target !== undefined) {
    const relative = path.win32.relative(requestedRoot, target)
    if (relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative) && !/[\x00-\x1f]/.test(relative))
      facts.lastRelativePath = relative || '.'
  }
  return broker.request(operation, input)
}
const filesystem = createWindowsOwnerFilesystem(input => request(input.op, input))
const handles: WindowsOwnerDirectory[] = []
const retain = (handle: WindowsOwnerDirectory): WindowsOwnerDirectory => { handles.push(handle); return handle }
const closeFixtureWriters = async () => {
  // Fixture creators hold DELETE and intentionally deny sharing it. Release
  // these setup handles before a fresh CLI's normal existing-only admission.
  for (const handle of [...handles].reverse()) await handle.close()
}
type FixturePowerShellPhase = 'tree_acl_snapshot' | 'probe_metadata_acl' | 'discovery_acl_fixture' |
  'appcontainer_sid_derivation' | 'metadata_acl_install' | 'metadata_acl_restore' |
  'project_acl_snapshot' | 'project_acl_install' | 'project_acl_restore'
const powershell = async (phase: FixturePowerShellPhase, script: string, target: string,
  extra: Record<string, string> = {}): Promise<string> => {
  assert.ok(process.env.ProgramFiles && path.win32.isAbsolute(process.env.ProgramFiles))
  const powershellRoot = path.win32.join(process.env.ProgramFiles, 'PowerShell', '7')
  // Compile inside the error boundary so parser failures also retain finite
  // original facts. Never forward ErrorRecord text, targets or raw stderr.
  const wrapped = `
$ErrorActionPreference='Stop'
try{
$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString('base64')}'))
& ([ScriptBlock]::Create($source))
}catch{
$failure=$_;$exception=$failure.Exception;$inner=$exception.InnerException
$line=$failure.InvocationInfo.ScriptLineNumber;$column=$failure.InvocationInfo.OffsetInLine
$parse=$exception;if($inner -is [System.Management.Automation.ParseException]){$parse=$inner}
if($parse -is [System.Management.Automation.ParseException] -and $parse.Errors.Count-gt 0){
$line=$parse.Errors[0].Extent.StartLineNumber;$column=$parse.Errors[0].Extent.StartColumnNumber}
$packet=[ordered]@{category=[int]$failure.CategoryInfo.Category;exceptionType=$exception.GetType().Name;hResult=$exception.HResult;innerExceptionType=$null;innerHResult=$null;nativeExitCode=$LASTEXITCODE;line=$line;column=$column}
if($null-ne $inner){$packet.innerExceptionType=$inner.GetType().Name;$packet.innerHResult=$inner.HResult}
[Console]::Error.WriteLine(('TEST_fixture_powershell_packet:'+(ConvertTo-Json -InputObject $packet -Compress)))
exit 1
}`
  const child = Bun.spawn([path.win32.join(powershellRoot, 'pwsh.exe'), '-NoProfile', '-NonInteractive',
    '-Command', wrapped], {
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      PSModulePath: path.win32.join(powershellRoot, 'Modules'), TEST_TARGET: target, ...extra }, stdout: 'pipe', stderr: 'pipe',
  })
  const readDiagnostic = async () => {
    const reader = child.stderr.getReader()
    let retained = Buffer.alloc(0), total = 0
    for (;;) {
      const part = await reader.read(); if (part.done) break
      total += part.value.byteLength
      retained = Buffer.concat([retained, Buffer.from(part.value)]).subarray(-4096)
    }
    return { text: retained.toString('utf8'), truncated: total > retained.length }
  }
  const [output, diagnostic, code] = await Promise.all([new Response(child.stdout).text(), readDiagnostic(), child.exited])
  if (code !== 0) {
    let row: Record<string, unknown> = {}
    try {
      const packet = diagnostic.text.split('\n').reverse().find(line => line.startsWith('TEST_fixture_powershell_packet:'))
      if (packet) row = executionRecord(JSON.parse(packet.slice('TEST_fixture_powershell_packet:'.length)))
    } catch { /* Closed unknown fields below. */ }
    const categories = ['NotSpecified', 'OpenError', 'CloseError', 'DeviceError', 'DeadlockDetected',
      'InvalidArgument', 'InvalidData', 'InvalidOperation', 'InvalidResult', 'InvalidType', 'MetadataError',
      'NotImplemented', 'NotInstalled', 'ObjectNotFound', 'OperationStopped', 'OperationTimeout',
      'SyntaxError', 'ParserError', 'PermissionDenied', 'ResourceBusy', 'ResourceExists', 'ResourceUnavailable',
      'ReadError', 'WriteError', 'FromStdErr', 'SecurityError', 'ProtocolError', 'ConnectionError',
      'AuthenticationError', 'LimitsExceeded', 'QuotaExceeded', 'NotEnabled']
    const exceptionTypes = ['CommandNotFoundException', 'MethodInvocationException', 'RuntimeException',
      'ItemNotFoundException', 'UnauthorizedAccessException', 'IOException', 'FileNotFoundException',
      'DirectoryNotFoundException', 'ArgumentException', 'ArgumentNullException', 'InvalidOperationException',
      'NotSupportedException', 'Win32Exception', 'ParseException', 'ActionPreferenceStopException',
      'SecurityException', 'ProviderInvocationException', 'ParameterBindingException', 'PSArgumentException',
      'PSInvalidOperationException', 'PSNotSupportedException', 'PSInvalidCastException', 'CmdletInvocationException',
      'ParentContainsErrorRecordException', 'ApplicationFailedException', 'NativeCommandExitException']
    const number = (value: unknown, minimum: number, maximum: number) =>
      Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : null
    const category = number(row.category, 0, categories.length - 1)
    facts.powershellFailure ??= { phase, exitCode: code, scriptSha256: createHash('sha256').update(script).digest('hex'),
      category: category === null ? null : categories[category], categoryId: category,
      exceptionType: exceptionTypes.find(name => name === row.exceptionType) ?? null,
      hResult: number(row.hResult, -0x80000000, 0x7fffffff),
      innerExceptionType: exceptionTypes.find(name => name === row.innerExceptionType) ?? null,
      innerHResult: number(row.innerHResult, -0x80000000, 0x7fffffff),
      nativeExitCode: number(row.nativeExitCode, -0x80000000, 0x7fffffff),
      generatedScriptLine: number(row.line, 1, Math.min(100000, script.split('\n').length)),
      generatedScriptColumn: number(row.column, 1, 100000), diagnosticTruncated: diagnostic.truncated }
    throw new Error('TEST_fixture_powershell_failed')
  }
  return output.trim()
}
// Observe only this new synthetic tree: native VolumeSerial/FileID/SID,
// complete owner/DACL descriptors, names and file bytes. Discovery must preserve it.
const snapshot = async (root: string): Promise<unknown[]> => {
  const rows: unknown[] = []
  const descriptors: Array<{ path: string; sddl: string }> = JSON.parse(await powershell('tree_acl_snapshot', `
    $items=@((Get-Item -LiteralPath $env:TEST_TARGET);(Get-ChildItem -LiteralPath $env:TEST_TARGET -Recurse -Force));
    $rows=@($items | ForEach-Object {[ordered]@{path=$_.FullName;sddl=(Get-Acl -LiteralPath $_.FullName).Sddl}});
    [Console]::Write((ConvertTo-Json -InputObject $rows -Compress))`, root))
  const acls = new Map(descriptors.map(row => [row.path.toLowerCase(), row.sddl]))
  const aclFor = (file: string) => { const acl = acls.get(file.toLowerCase()); assert.ok(acl); return acl }
  const walk = async (directory: string): Promise<void> => {
    const held = await filesystem.openDirectory(directory)
    try {
      const entries = (await readdir(directory)).sort()
      rows.push({ relative: path.win32.relative(root, directory), identity: held.identity, acl: aclFor(directory), entries })
      for (const name of entries) {
        const file = path.win32.join(directory, name), info = await lstat(file)
        assert.equal(info.isSymbolicLink(), false)
        if (info.isDirectory()) await walk(file)
        else rows.push({ relative: path.win32.relative(root, file), acl: aclFor(file), device: info.dev,
          inode: info.ino, birth: info.birthtimeMs, mtime: info.mtimeMs,
          bytes: createHash('sha256').update(await readFile(file)).digest('hex') })
      }
    } finally { await held.close() }
  }
  await walk(root)
  return rows
}
type RouterExpectation = 'v1' | 'veto' | 'owner'
const route = async (dataRoot: string, runId: string, expected: RouterExpectation,
  selection: 'v1' | 'unsupported' | 'missing' = 'v1', ownerRecord?: unknown, heldRead = false, statusBatch = 0) => {
  await closeFixtureWriters()
  // A fresh CLI owns its retained discovery brokers until process exit, as in
  // production. Only selection and the V1 executor are stubbed; native discovery
  // and the router are real. No source-discovery or native-helper mocks.
  const script = `import {mock} from 'bun:test';import assert from 'node:assert/strict';
    let phase='imports';const diagnostic={expected:${JSON.stringify(expected)},selection:${JSON.stringify(selection)}};
    const safeCode=value=>{const match=typeof value==='string'?/^(?:execution_|run_|cleanup_)[a-z_]+(?::[a-z_]+)?(?::[0-9]+)?$/.exec(value):null;return match?match[0]:'TEST_route_assertion'};
    try { let probes=0,legacy=0;const selection=${JSON.stringify(selection)};
    const factory=${JSON.stringify(import.meta.resolve('../../src/services/opencode/bridge/OpenCodeRuntimeAdapterFactory.ts'))};
    const f=await import(factory);mock.module(factory,()=>({...f,inspectOpenCodeRuntimeAdapterSelection:async()=>{
      probes++;if(selection==='missing')throw Error('TEST_selected_CLI_removed');
      return {policy:{generation:selection==='v1'?'v1':'unsupported',version:selection==='v1'?'1.19.0':'2.0.1'}};
    }}));
    const root=${JSON.stringify(dataRoot)},runId=${JSON.stringify(runId)},expected=${JSON.stringify(expected)};
    const {discoverOpenCodeV2Run,requestOpenCodeV2Run}=await import(${JSON.stringify(import.meta.resolve('../../src/services/opencode/bridge/OpenCodeV2RunControl.ts'))});
    phase='native_discovery';
    if(expected==='v1')assert.equal(await discoverOpenCodeV2Run(root,'TEST-team',runId),null);
    if(expected==='owner')assert.deepEqual(await discoverOpenCodeV2Run(root,'TEST-team',runId),${JSON.stringify(ownerRecord ?? null)});
    if(${JSON.stringify(statusBatch)}>0){
      phase='same_client_status_batch';const owner=await discoverOpenCodeV2Run(root,'TEST-team',runId);
      assert.ok(owner);
      for(let index=0;index<${JSON.stringify(statusBatch)};index++){
        const remaining=Math.min(30000,owner.deadline-Date.now());assert.ok(remaining>0);
        const response=await requestOpenCodeV2Run(owner,{operation:'status'},remaining);
        assert.equal(response.kind,'status');assert.equal(response.state,'stopped');
      }
      console.log(JSON.stringify({expected,selection,statusBatch:${JSON.stringify(statusBatch)}}));process.exit(0);
    }
    if(${JSON.stringify(heldRead)}){
      phase='held_read';const owner=await discoverOpenCodeV2Run(root,'TEST-team',runId);
      assert.ok(owner);const started=Date.now();
      await assert.rejects(requestOpenCodeV2Run(owner,{operation:'status'},30000),
        error=>error instanceof Error&&error.message==='run_control_timeout:read:995');
      assert.ok(Date.now()-started<30000,'TEST_native_read_exceeded_original_budget');
      phase='same_client_after_timeout';
      const recovered=await requestOpenCodeV2Run(owner,{operation:'status'},30000);
      assert.equal(recovered.kind,'status');assert.equal(recovered.state,'stopped');
      console.log(JSON.stringify({expected,selection,heldReadRetired:true,sameClientRecovered:true}));process.exit(0);
    }
    process.env.CLAUDE_MULTIMODEL_DATA_HOME=root;
    const {executeSelectedOpenCodeBridgeCommandEnvelope:execute}=await import(${JSON.stringify(import.meta.resolve('../../src/services/opencode/bridge/OpenCodeV2TeamBridge.ts'))});
    phase='bridge_execute';
    const result=await execute({schemaVersion:1,requestId:'TEST-discovery',command:expected==='owner'?'opencode.commandStatus':'opencode.handshake',
      cwd:root,startedAt:new Date().toISOString(),timeoutMs:5000,body:{teamId:'TEST-team',expectedRunId:runId}},
      async()=>{legacy++;return 'TEST-V1'});
    phase='bridge_assert';diagnostic.bridgeCode=safeCode(result?.error?.message);
    if(expected==='v1'){assert.equal(result,'TEST-V1');assert.equal(probes,1);assert.equal(legacy,1)}
    else{assert.equal(legacy,0);assert.equal(probes,expected==='owner'||selection==='v1'?0:1);
      if(expected==='veto')assert.equal(result.ok,false);
      if(expected==='owner'){assert.equal(result.ok,true);assert.equal(result.data.status,'unknown')}}
    console.log(JSON.stringify({expected,selection,probes,legacy}));process.exit(0);
    }catch(error){console.log(JSON.stringify({...diagnostic,phase,errorCode:safeCode(error?.message)}));process.exit(1)}`
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: requestedRoot, stdout: 'pipe', stderr: 'ignore' })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) facts.routerFailure = executionRecord(JSON.parse(output))
  assert.equal(code, 0, 'TEST_real_windows_discovery_route_failed')
  return executionRecord(JSON.parse(output))
}
const writeOwnedFixture = async (directory: WindowsOwnerDirectory, directoryPath: string,
  name: 'opencode.json' | 'opencode.db' | 'start.json' | 'user.json' | 'other.json', bytes: string | Uint8Array) => {
  const relative = path.win32.relative(requestedRoot, directoryPath)
  assert.ok(relative && relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative))
  // Copy only the native reference's exact owner and protected DACL onto this
  // fresh fixture, retaining genuine zero-length, malformed, and oversized bytes.
  await directory.writeExclusive('owner.json', { schema: 1, synthetic: true })
  const source = path.win32.join(directoryPath, 'owner.json')
  const target = path.win32.join(directoryPath, name)
  await writeFile(target, bytes, { flag: 'wx' })
  assert.ok(process.env.ProgramFiles && path.win32.isAbsolute(process.env.ProgramFiles))
  const powershellRoot = path.win32.join(process.env.ProgramFiles, 'PowerShell', '7')
  const child = Bun.spawn([path.win32.join(powershellRoot, 'pwsh.exe'), '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
$diagnostic=[ordered]@{phase='startup';referenceProtected=$null;referenceOwnerMatches=$null;targetProtected=$null;descriptorMatches=$null;targetOwnerMatches=$null;rawDaclMatches=$null;referenceControlFlags=$null;targetControlFlags=$null;exceptionType=$null;hResult=$null}
try{
$sections=[System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
$diagnostic.phase='reference_read'
$reference=Get-Acl -LiteralPath $env:TEST_REFERENCE
$diagnostic.referenceProtected=$reference.AreAccessRulesProtected
$diagnostic.phase='reference_owner'
$owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$diagnostic.referenceOwnerMatches=$reference.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $owner.Value
$diagnostic.phase='reference_check'
if(!$diagnostic.referenceProtected -or !$diagnostic.referenceOwnerMatches){throw 'TEST reference is not private'}
$diagnostic.phase='reference_descriptor'
$exact=$reference.GetSecurityDescriptorSddlForm($sections)
$diagnostic.phase='target_read'
$target=Get-Acl -LiteralPath $env:TEST_TARGET
$diagnostic.phase='target_prepare'
$target.SetSecurityDescriptorSddlForm($exact,$sections)
$diagnostic.phase='target_write'
Set-Acl -LiteralPath $env:TEST_TARGET -AclObject $target
$diagnostic.phase='target_verify'
$actual=Get-Acl -LiteralPath $env:TEST_TARGET
$diagnostic.targetProtected=$actual.AreAccessRulesProtected
$diagnostic.descriptorMatches=$actual.GetSecurityDescriptorSddlForm($sections) -ceq $exact
$diagnostic.targetOwnerMatches=$actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $reference.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$diagnostic.phase='target_binary'
$referenceRaw=[System.Security.AccessControl.RawSecurityDescriptor]::new($reference.GetSecurityDescriptorBinaryForm(),0)
$actualRaw=[System.Security.AccessControl.RawSecurityDescriptor]::new($actual.GetSecurityDescriptorBinaryForm(),0)
$diagnostic.referenceControlFlags=[int]$referenceRaw.ControlFlags
$diagnostic.targetControlFlags=[int]$actualRaw.ControlFlags
$present=[System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent
if($null -eq $referenceRaw.DiscretionaryAcl -or $null -eq $actualRaw.DiscretionaryAcl -or ($referenceRaw.ControlFlags -band $present) -eq 0 -or ($actualRaw.ControlFlags -band $present) -eq 0){throw 'TEST fixture DACL missing'}
$referenceBytes=[byte[]]::new($referenceRaw.DiscretionaryAcl.BinaryLength)
$actualBytes=[byte[]]::new($actualRaw.DiscretionaryAcl.BinaryLength)
$referenceRaw.DiscretionaryAcl.GetBinaryForm($referenceBytes,0)
$actualRaw.DiscretionaryAcl.GetBinaryForm($actualBytes,0)
$diagnostic.rawDaclMatches=[Convert]::ToBase64String($referenceBytes) -ceq [Convert]::ToBase64String($actualBytes)
$diagnostic.phase='target_check'
if(!$diagnostic.targetProtected -or !$diagnostic.targetOwnerMatches -or !$diagnostic.rawDaclMatches){throw 'TEST fixture security copy changed'}
}catch{
$failure=$_.Exception
if($failure.InnerException){$failure=$failure.InnerException}
$diagnostic.exceptionType=$failure.GetType().Name
$diagnostic.hResult=$failure.HResult
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $diagnostic -Compress))
exit 1
}
`], { env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    PSModulePath: path.win32.join(powershellRoot, 'Modules'), TEST_REFERENCE: source, TEST_TARGET: target },
    stdout: 'pipe', stderr: 'ignore' })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) {
    const diagnostic: Record<string, unknown> = { exitCode: code, phase: 'unavailable' }
    try {
      assert.ok(out.length <= 2048)
      const observed = executionRecord(JSON.parse(out))
      if (typeof observed.phase === 'string' && /^[a-z_]{1,32}$/.test(observed.phase)) diagnostic.phase = observed.phase
      if (typeof observed.exceptionType === 'string' && /^[A-Za-z_]{1,96}$/.test(observed.exceptionType)) diagnostic.exceptionType = observed.exceptionType
      if (typeof observed.hResult === 'number' && Number.isInteger(observed.hResult) && observed.hResult >= -2147483648 && observed.hResult <= 2147483647) diagnostic.hResult = observed.hResult
      for (const key of ['referenceProtected', 'referenceOwnerMatches', 'targetProtected', 'descriptorMatches', 'targetOwnerMatches', 'rawDaclMatches']) {
        if (typeof observed[key] === 'boolean') diagnostic[key] = observed[key]
      }
      for (const key of ['referenceControlFlags', 'targetControlFlags']) {
        if (typeof observed[key] === 'number' && Number.isInteger(observed[key]) && observed[key] >= 0 && observed[key] <= 65535) diagnostic[key] = observed[key]
      }
    } catch { /* Invalid or absent structured diagnostics retain only exit status. */ }
    facts.fixtureSecurityFailure = diagnostic
  }
  assert.equal(code, 0, 'windows_fixture_security_copy_failed')
}
const lease = 'b04ca87c-d84d-4b55-a89a-9c8fa7bd1f16'
let failure: unknown
try {
  const selectedBefore = await imageSnapshot(helper.path)
  const freshSelection = await resolveWindowsNativeArtifact()
  assert.equal(freshSelection.path, helper.path)
  assert.equal(freshSelection.sha256, helper.sha256)
  assert.deepEqual(await imageSnapshot(freshSelection.path), selectedBefore)
  assert.equal(selectedBefore.sha256, producerBefore.sha256)
  assert.notEqual(helper.path, producerPath)
  assert.equal(helper.path, path.win32.join(process.env.LOCALAPPDATA!,
    'AgentTeams.OpenCodeV2.Native', helper.sha256, 'opencode-v2-windows-helper.exe'))
  // Raw bootstrap transport cannot create owner/run state or accept a caller
  // supplied source/destination. A wrong producer SHA cannot select an image.
  const bootstrap = Bun.spawn([producerPath, '--self-image-custody', helper.sha256], {
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, LOCALAPPDATA: process.env.LOCALAPPDATA },
    stdin: new Blob([JSON.stringify({ schema: 1, id: 1, operation: 'ownerCreateDirectory',
      input: { path: path.win32.join(requestedRoot, 'TEST-bootstrap-forbidden') } }) + '\n',
      JSON.stringify({ schema: 1, id: 2, operation: 'selfImageCustody', input: { path: producerPath } }) + '\n']),
    stdout: 'pipe', stderr: 'ignore',
  })
  const replies = (await new Response(bootstrap.stdout).text()).trim().split('\n').map(line => executionRecord(JSON.parse(line)))
  assert.equal(await bootstrap.exited, 0)
  assert.equal(replies.length, 2)
  for (const reply of replies) { assert.equal(reply.ok, false); assert.equal(reply.error, 'execution_invalid_response') }
  await assert.rejects(lstat(path.win32.join(requestedRoot, 'TEST-bootstrap-forbidden')), { code: 'ENOENT' })
  const wrongSha = (helper.sha256[0] === '0' ? '1' : '0') + helper.sha256.slice(1)
  const wrongProducer = Bun.spawn([producerPath, '--self-image-custody', wrongSha], {
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, LOCALAPPDATA: process.env.LOCALAPPDATA },
    stdin: new Blob([JSON.stringify({ schema: 1, id: 1, operation: 'selfImageCustody', input: {} }) + '\n']),
    stdout: 'pipe', stderr: 'ignore',
  })
  const wrongReply = executionRecord(JSON.parse(await new Response(wrongProducer.stdout).text()))
  assert.equal(await wrongProducer.exited, 0)
  assert.equal(wrongReply.ok, false)
  assert.equal(wrongReply.error, 'execution_containment_helper_identity')
  facts.nativeImageCustody = { producerSha256: helper.sha256, stableSelectedFile: true,
    selectedImageIsPrivateSlot: true, bootstrapRejectsUnrelatedOperationsAndPaths: true,
    wrongProducerShaRejected: true }
  const setupRoot = await filesystem.createDirectory(requestedRoot)
  // The scratch parent is setup only. Actual source fences below retain their
  // original DELETE-capable handles; the existing parent needs traversal only.
  await setupRoot.close()
  // Independent helper processes must coexist while a preparatory creator
  // retains the parent. Execution-owner creators deliberately remain exclusive.
  const peerBroker = createWindowsNativeBroker(helper)
  peerBroker.events.on('error', () => {})
  const peerFilesystem = createWindowsOwnerFilesystem(input => peerBroker.request(input.op, input))
  const preparedRoot = path.win32.join(requestedRoot, 'TEST-private-preparation')
  let prepared: Record<string, unknown> | undefined
  const creatorFilesystem = createWindowsOwnerFilesystem(async input => {
    const result = await broker.request(input.op, input)
    if (input.op === 'ownerPreparePrivateDirectory' && input.path === preparedRoot && input.createExclusive)
      prepared = executionRecord(result)
    return result
  })
  let creatorReady!: () => void, releaseCreator!: () => void
  const ready = new Promise<void>(resolve => { creatorReady = resolve })
  const released = new Promise<void>(resolve => { releaseCreator = resolve })
  // Pause the public producer's final close, not its native admission or checks.
  const preparation = prepareWindowsPrivateDirectories([preparedRoot], {
    prepareDirectory: async (directory, create) => {
      const held = await creatorFilesystem.prepareDirectory(directory, create)
      return { ...held, close: async () => { creatorReady(); await released; await held.close() } }
    },
  })
  let ordinaryCreator: WindowsOwnerDirectory | undefined
  try {
    await Promise.race([ready, preparation.then(() => { throw new Error('TEST_creator_not_retained') })])
    assert.ok(prepared && typeof prepared.handleId === 'string')
    const preparedId = prepared.handleId
    await assert.rejects(broker.request('ownerArchive', { handleId: preparedId,
      source: preparedRoot, destination: preparedRoot + '.released.' + crypto.randomUUID() }), /execution_owner_read_only/)
    await assert.rejects(broker.request('ownerWriteExclusive', { handleId: preparedId,
      name: 'owner.json', bytesBase64: Buffer.from('{}\n').toString('base64') }), /execution_owner_read_only/)
    const child = path.win32.join(preparedRoot, 'TEST-child')
    await prepareWindowsPrivateDirectories([preparedRoot, child], peerFilesystem)
    const independentlyOpened = await peerFilesystem.openDirectory(preparedRoot)
    try {
      assert.deepEqual(independentlyOpened.identity, prepared.identity)
      await independentlyOpened.assertOwned()
    } finally { await independentlyOpened.close() }
    const ordinaryPath = path.win32.join(requestedRoot, 'TEST-ordinary-owner-fence')
    ordinaryCreator = await filesystem.createDirectory(ordinaryPath)
    await assert.rejects(prepareWindowsPrivateDirectories([path.win32.join(ordinaryPath, 'TEST-child')],
      peerFilesystem), /execution_owner_unknown:owner_canonical_open:32/)
    await ordinaryCreator.assertOwned()
    assert.equal((await readdir(ordinaryPath)).length, 0)
    facts.privateDirectoryPreparation = { twoIndependentBrokers: true, retainedCreatorDuringPeerAdmission: true,
      sameIdentity: true, childCreated: true, preparatoryArchiveAndExclusiveWriteDenied: true,
      ordinaryOwnerStillDeniesConflictingAncestorOpen: true }
  } finally {
    releaseCreator()
    const closed = await Promise.allSettled([preparation, ordinaryCreator?.close()])
    await peerBroker.close()
    assert.equal(peerBroker.ended(), true)
    assert.equal(closed.every(result => result.status === 'fulfilled'), true)
  }
  // Exercise the production fixed-purpose writer through an existing-only
  // retained directory, including its strict veto of unsafe existing metadata.
  const probeBase = path.win32.join(requestedRoot, 'opencode', 'v2', 'execution-probes')
  for (const directory of [path.win32.join(requestedRoot, 'opencode'),
    path.win32.join(requestedRoot, 'opencode', 'v2'), probeBase])
    retain(await filesystem.createDirectory(directory))
  const probePath = path.win32.join(probeBase, 'b'.repeat(64))
  const createdProbe = await filesystem.createDirectory(probePath)
  await createdProbe.close()
  const probeDirectory = retain(await filesystem.openDirectory(probePath))
  await probeDirectory.writeMetadata('ProbeGuard', null)
  const guardBefore = await probeDirectory.readMetadata('ProbeGuard')
  assert.equal(guardBefore.bytes, 0)
  assert.equal(guardBefore.fileIdentity?.ownerSid, probeDirectory.identity.ownerSid)
  await probeDirectory.writeMetadata('ProbeGuard', null)
  assert.deepEqual((await probeDirectory.readMetadata('ProbeGuard')).fileIdentity, guardBefore.fileIdentity)
  const firstRecord = { schema: 1, synthetic: true, marker: 'first-é' }
  await probeDirectory.writeMetadata('ProbeRecord', firstRecord)
  const recordBefore = await probeDirectory.readMetadata('ProbeRecord')
  assert.deepEqual(recordBefore.value, firstRecord)
  assert.equal(recordBefore.fileIdentity?.ownerSid, probeDirectory.identity.ownerSid)
  const secondRecord = { schema: 1, synthetic: true, marker: 'second-é' }
  await probeDirectory.writeMetadata('ProbeRecord', secondRecord)
  const recordAfter = await probeDirectory.readMetadata('ProbeRecord')
  assert.deepEqual(recordAfter.value, secondRecord)
  assert.notEqual(recordAfter.fileIdentity?.fileId, recordBefore.fileIdentity?.fileId)
  assert.deepEqual((await probeDirectory.readMetadata('ProbeGuard')).fileIdentity, guardBefore.fileIdentity)
  await powershell('probe_metadata_acl', `$a=Get-Acl -LiteralPath $env:TEST_TARGET;
    $sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545');
    $r=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow');
    $a.AddAccessRule($r);Set-Acl -LiteralPath $env:TEST_TARGET -AclObject $a`, path.win32.join(probePath, 'probe.json'))
  const unsafeProbeBefore = await snapshot(probePath)
  await assert.rejects(probeDirectory.writeMetadata('ProbeRecord', firstRecord), /execution_owner_not_private/)
  assert.deepEqual(await snapshot(probePath), unsafeProbeBefore)
  facts.probeMetadata = { guardPrivateZeroByte: true, guardIdempotentIdentity: true,
    recordPrivateCreateAndAtomicReplacement: true, unsafeExistingVetoWithoutMutation: true }
  const discoveryRoot = path.win32.join(requestedRoot, 'TEST-discovery')
  retain(await filesystem.createDirectory(discoveryRoot))
  const absenceStages: string[] = []
  const proveAbsence = async (stage: string) => {
    const before = await snapshot(discoveryRoot)
    const directory = runControlDirectory(discoveryRoot, 'TEST-team', 'TEST-fresh')
    const absent = await request('runStateDiscover', { dataRoot: discoveryRoot, directory,
      teamId: 'TEST-team', runId: 'TEST-fresh', selectionIds: [] })
    assert.deepEqual(absent, { absent: true }) // No state/control/selection authority.
    await assert.rejects(request('runStateDiscover', { dataRoot: discoveryRoot, directory,
      teamId: 'TEST-team', runId: 'TEST-fresh', selectionIds: ['TEST-invalid'] }))
    // An absence response cannot be used as a state capability.
    await assert.rejects(request('runStateReadRecord', { directory, stateId: '', name: 'start.json' }))
    await assert.rejects(request('runStateAcquire', { dataRoot: discoveryRoot, directory,
      binding: { teamId: 'TEST-team', runId: 'TEST-fresh', controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' },
      selectionIds: [] }))
    await route(discoveryRoot, 'TEST-fresh', 'v1')
    assert.deepEqual(await snapshot(discoveryRoot), before)
    absenceStages.push(stage)
  }
  await proveAbsence('missing-opencode-no-profiles')
  const discoveryOpencode = path.win32.join(discoveryRoot, 'opencode')
  retain(await filesystem.createDirectory(discoveryOpencode))
  await proveAbsence('missing-v2-no-profiles')
  const discoveryV2 = path.win32.join(discoveryOpencode, 'v2')
  retain(await filesystem.createDirectory(discoveryV2))
  retain(await filesystem.createDirectory(path.win32.join(discoveryV2, 'profiles')))
  await proveAbsence('missing-runs-empty-profiles')
  const discoveryRuns = path.win32.join(discoveryV2, 'runs')
  retain(await filesystem.createDirectory(discoveryRuns))
  await proveAbsence('missing-final-empty-profiles')
  await route(discoveryRoot, 'TEST-fresh', 'veto', 'unsupported')
  const emptyFence = runControlDirectory(discoveryRoot, 'TEST-team', 'TEST-empty-fence')
  retain(await filesystem.createDirectory(emptyFence))
  const emptyBefore = await snapshot(discoveryRoot)
  await route(discoveryRoot, 'TEST-empty-fence', 'veto')
  assert.deepEqual(await snapshot(discoveryRoot), emptyBefore)
  // Reparse and DACL fixtures affect only NEW isolated synthetic data roots.
  const reparseRoot = path.win32.join(requestedRoot, 'TEST-reparse-discovery')
  retain(await filesystem.createDirectory(reparseRoot))
  await symlink(discoveryOpencode, path.win32.join(reparseRoot, 'opencode'), 'junction')
  await route(reparseRoot, 'TEST-fresh', 'veto')
  for (const guard of ['foreign-allow', 'access-denied'] as const) {
    const guardedRoot = path.win32.join(requestedRoot, 'TEST-' + guard)
    const ownedRoot = await filesystem.createDirectory(guardedRoot)
    await ownedRoot.close()
    await powershell('discovery_acl_fixture', `$a=Get-Acl -LiteralPath $env:TEST_TARGET;
      $sid=${guard === 'foreign-allow' ? "[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')" : '[System.Security.Principal.WindowsIdentity]::GetCurrent().User'};
      $r=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute','${guard === 'foreign-allow' ? 'Allow' : 'Deny'}');
      $a.AddAccessRule($r);Set-Acl -LiteralPath $env:TEST_TARGET -AclObject $a`, guardedRoot)
    await route(guardedRoot, 'TEST-fresh', 'veto')
  }
  // Canonical-name evidence must reject an alias even on an absent run.
  await assert.rejects(request('runStateDiscover', { dataRoot: discoveryRoot + '\\.',
    directory: discoveryRoot + '\\.\\opencode\\v2\\runs\\' + 'a'.repeat(32),
    teamId: 'TEST-team', runId: 'TEST-fresh', selectionIds: [] }))
  facts.discoveryAbsence = { stages: absenceStages, namespaceAclIdentityAndBytesUnchanged: true,
    noStateAuthority: true, emptyFenceVeto: true, reparseVeto: true, foreignAclVeto: true,
    accessDeniedVeto: true, canonicalAliasVeto: true, unsupportedNeverFallsBack: true }
  const originalPath = path.win32.join(requestedRoot, '.opencode-v2-execution-owner')
  const original = retain(await filesystem.createDirectory(originalPath))
  const originalOwnerRecord = { schema: 1, synthetic: true, leaseOwnerId: lease, marker: 'retained-original-é' }
  await original.writeExclusive('owner.json', originalOwnerRecord)
  await assert.rejects(filesystem.createDirectory(originalPath))
  await assert.rejects(original.writeExclusive('owner.json', originalOwnerRecord))
  // An uncertain/failed mutation poisons this capability, so acquire a separate
  // original directory for the successful archive instead of replaying it.
  await original.close()
  const successPath = path.win32.join(requestedRoot, '.successful-owner')
  const successArchive = successPath + '.released.' + lease
  const success = retain(await filesystem.createDirectory(successPath))
  await success.writeExclusive('owner.json', originalOwnerRecord)
  const before = success.identity
  await success.archive(successArchive)
  await success.assertOwned()
  assert.deepEqual(success.identity, before)
  assert.deepEqual(await success.readRecord('owner.json'), originalOwnerRecord)
  const archived = retain(await filesystem.openDirectory(successArchive))
  assert.deepEqual(archived.identity, before)
  assert.deepEqual(await archived.readRecord('owner.json'), originalOwnerRecord)
  await assert.rejects(archived.writeExclusive('release.json', { forbidden: true }))
  const next = retain(await filesystem.createDirectory(successPath))
  assert.notDeepEqual(next.identity, before)
  const nextRecord = { schema: 1, synthetic: true, marker: 'next-owner' }
  await next.writeExclusive('owner.json', nextRecord)
  // Target collision must retain BOTH source and preexisting destination bytes.
  await assert.rejects(next.archive(successArchive))
  assert.deepEqual(await archived.readRecord('owner.json'), originalOwnerRecord)
  const sourceAfterCollision = retain(await filesystem.openDirectory(successPath))
  assert.deepEqual(sourceAfterCollision.identity, next.identity)
  assert.deepEqual(await sourceAfterCollision.readRecord('owner.json'), nextRecord)
  await assert.rejects(filesystem.createDirectory(successPath))
  const partialPath = path.win32.join(requestedRoot, '.partial-owner')
  const partial = retain(await filesystem.createDirectory(partialPath))
  await partial.close()
  await assert.rejects(filesystem.createDirectory(partialPath))
  const retainedOriginal = retain(await filesystem.openDirectory(originalPath))
  assert.deepEqual(await retainedOriginal.readRecord('owner.json'), originalOwnerRecord)
  const inspect = async (name: string, config?: string) => {
    const profile = path.win32.join(requestedRoot, name)
    retain(await filesystem.createDirectory(profile))
    const configDirectory = path.win32.join(profile, "config")
    retain(await filesystem.createDirectory(configDirectory))
    const opencodeDirectory = path.win32.join(configDirectory, "opencode")
    const ownedConfig = retain(await filesystem.createDirectory(opencodeDirectory))
    if (config !== undefined) await writeOwnedFixture(ownedConfig, opencodeDirectory, "opencode.json", config)
    return executionRecord(await request("ownerInspectProfileConfig", {
      root: profile, databasePath: path.win32.join(profile, "data", "opencode", "opencode.db"),
    }))
  }
  const absent = await inspect("TEST-profile-absent", undefined)
  const incomplete = await inspect("TEST-profile-incomplete", "")
  const malformedComplete = await inspect("TEST-profile-malformed-complete", "{TEST-malformed")
  assert.equal(absent.state, "absent"); assert.equal(absent.configIdentity, null)
  assert.equal(incomplete.state, "incomplete"); assert.notEqual(incomplete.configIdentity, null)
  assert.equal(malformedComplete.state, "complete"); assert.notEqual(malformedComplete.configIdentity, null)
  const selectedRoot = path.win32.join(discoveryV2, 'profiles', "TEST-selected-profile")
  retain(await filesystem.createDirectory(selectedRoot))
  for (const name of ["home", "config", "data", "cache", "state", "tmp", "appdata", "localappdata"])
    retain(await filesystem.createDirectory(path.win32.join(selectedRoot, name)))
  const selectedConfigDirectory = path.win32.join(selectedRoot, "config", "opencode")
  const ownedSelectedConfig = retain(await filesystem.createDirectory(selectedConfigDirectory))
  const selectedDataDirectory = path.win32.join(selectedRoot, "data", "opencode")
  const ownedSelectedData = retain(await filesystem.createDirectory(selectedDataDirectory))
  // Real exclusive zero-byte DB custody; the official runtime owns schema bootstrap.
  await ownedSelectedData.createPreparedDatabase()
  assert.equal((await readFile(path.win32.join(selectedDataDirectory, 'opencode.db'))).length, 0)
  const claudeRoot = path.win32.join(requestedRoot, "TEST-claude")
  retain(await filesystem.createDirectory(claudeRoot))
  retain(await filesystem.createDirectory(path.win32.join(claudeRoot, "teams")))
  retain(await filesystem.createDirectory(path.win32.join(claudeRoot, "teams", "TEST-team")))
  retain(await filesystem.createDirectory(path.win32.join(claudeRoot, "tasks")))
  retain(await filesystem.createDirectory(path.win32.join(claudeRoot, "tasks", "TEST-team")))
  const inboxes = path.win32.join(claudeRoot, "teams", "TEST-team", "inboxes")
  const ownedInbox = retain(await filesystem.createDirectory(inboxes))
  const inboxContent = JSON.stringify([{ messageId: 'TEST-inbox-message', from: 'worker', to: 'user',
    text: 'TEST-native-inbox-read', timestamp: '2026-10-15T00:00:00.000Z', read: false }])
  await writeOwnedFixture(ownedInbox, inboxes, "user.json", inboxContent)
  const selectedContent = JSON.stringify({ 'TEST-padding': 'x'.repeat(128 * 1024), mcpServers: { "agent-teams": { type: "local",
    env: { AGENT_TEAMS_MCP_CLAUDE_DIR: claudeRoot } } } })
  assert.ok(Buffer.byteLength(selectedContent) > 128 * 1024)
  const selectedHash = createHash('sha256').update(selectedContent).digest('hex')
  await ownedSelectedConfig.writePreparedConfig(selectedContent, selectedHash)
  assert.equal(await readFile(path.win32.join(selectedConfigDirectory, 'opencode.json'), 'utf8'), selectedContent)
  const authContent = JSON.stringify({ 'TEST-provider': { type: 'api', key: 'TEST-never-used' } }, null, 2)
  const authHash = createHash('sha256').update(authContent).digest('hex')
  await ownedSelectedData.writePreparedAuth(authContent, authHash)
  assert.equal(await readFile(path.win32.join(selectedDataDirectory, 'auth.json'), 'utf8'), authContent)
  // CREATE_NEW must refuse even an identical replacement; no repair/adoption.
  await assert.rejects(ownedSelectedConfig.writePreparedConfig(selectedContent, selectedHash))
  await assert.rejects(ownedSelectedData.writePreparedAuth(authContent, authHash))
  assert.equal(await readFile(path.win32.join(selectedConfigDirectory, 'opencode.json'), 'utf8'), selectedContent)
  assert.equal(await readFile(path.win32.join(selectedDataDirectory, 'auth.json'), 'utf8'), authContent)
  const databasePath = path.win32.join(selectedDataDirectory, "opencode.db")
  await closeFixtureWriters()
  await request("ownerValidateSelectedProfile", { root: selectedRoot, databasePath,
    directories: [selectedRoot, selectedConfigDirectory] })
  const assertConfigOnlySelection = (value: unknown) => {
    const selected = executionRecord(value)
    assert.ok(typeof selected.selectionId === "string" && /^[1-9]\d*$/.test(selected.selectionId))
    assert.deepEqual(selected, { schema: 1, ok: true, selectionId: selected.selectionId,
      root: selectedRoot, path: path.win32.join(selectedConfigDirectory, "opencode.json"),
      sha256: createHash("sha256").update(selectedContent).digest("hex") })
  }
  // Inbox binding and reads begin only after native cohort/team join. Config
  // selection returns no controller or inbox authority for any fixture below.
  const configSelection = await request("ownerSelectConfig", { root: selectedRoot, databasePath,
    sha256: createHash("sha256").update(selectedContent).digest("hex"), teamId: "TEST-team" })
  assertConfigOnlySelection(configSelection)
  const authMetadata = executionRecord(await request('ownerReadMetadata', {
    op: 'ownerReadMetadata', purpose: 'SelectedAuth', selectionId: executionRecord(configSelection).selectionId }))
  assert.equal(authMetadata.sha256, authHash)
  assert.equal(authMetadata.bytes, Buffer.byteLength(authContent))
  assert.equal(authMetadata.privateAcl, true)
  assert.equal(executionRecord(authMetadata.fileIdentity).ownerSid, executionRecord(authMetadata.directoryIdentity).ownerSid)
  // Bypass the TS capability guard to test the native read-only boundary too.
  for (const [directory, op, bytes, sha256] of [
    [selectedConfigDirectory, 'ownerWritePreparedConfig', selectedContent, selectedHash],
    [selectedDataDirectory, 'ownerWritePreparedAuth', authContent, authHash],
  ] as const) {
    for (const openOp of ['ownerOpenDirectory', 'ownerPreparePrivateDirectory'] as const) {
      const opened = executionRecord(await request(openOp, { path: directory, createExclusive: false }))
      try {
        await assert.rejects(request('ownerCreatePreparedDatabase', { op: 'ownerCreatePreparedDatabase', handleId: opened.handleId }), /execution_owner_read_only/)
        await assert.rejects(request(op, { op, handleId: opened.handleId,
          bytesBase64: Buffer.from(bytes).toString('base64'), sha256 }), /execution_owner_read_only/)
      } finally { await request('ownerCloseDirectory', { handleId: opened.handleId }) }
    }
  }
  facts.preparedZeroDatabaseNativePublication = true
  facts.preparedConfigAndAuthNativePublication = true
  facts.preparedFilesRefuseReplacementAndReadOnlyPublication = true
  const selectionIds = [String(executionRecord(configSelection).selectionId)]
  await proveAbsence('missing-final-complete-profile')
  const binding = { teamId: 'TEST-team', runId: 'TEST-unpublished', controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' }
  const directory = runControlDirectory(discoveryRoot, binding.teamId, binding.runId)
  const acquired = executionRecord(await request('runStateAcquire', { dataRoot: discoveryRoot, directory, binding, selectionIds }))
  const stateId = String(acquired.stateId), sourceSha256 = 'a'.repeat(64)
  const runDirectoryBefore = await lstat(directory)
  await assert.rejects(rename(directory, directory + '.TEST-forbidden-rename'),
    (error: unknown) => !!error && typeof error === 'object' && 'code' in error &&
      ['EACCES', 'EPERM', 'EBUSY'].includes(String(error.code)))
  const runDirectoryAfter = await lstat(directory)
  assert.equal(runDirectoryAfter.dev, runDirectoryBefore.dev)
  assert.equal(runDirectoryAfter.ino, runDirectoryBefore.ino)
  facts.runStateDirectoryStillDeniesExternalRename = true
  await request('runStateReserve', { stateId, directory, binding, sourceSha256, sharedControllerRootCohort: true })
  for (const name of ['start.json', 'challenge']) {
    const record = await lstat(path.win32.join(directory, name))
    assert.equal(record.isFile(), true)
    assert.equal(record.isSymbolicLink(), false)
    assert.equal(record.nlink, 1)
    if (name === 'challenge') assert.equal(record.size, 32)
  }
  facts.discoveryReservedRecordsAreFiles = true
  const unpublishedBefore = await snapshot(discoveryRoot)
  // This fails on the old native endpoint_missing -> absent conversion even
  // with valid selections, valid start/challenge and a sealed cohort.
  await assert.rejects(request('runStateDiscover', { dataRoot: discoveryRoot, directory,
    teamId: binding.teamId, runId: binding.runId, selectionIds }), /run_state_endpoint_missing/)
  await route(discoveryRoot, binding.runId, 'veto')
  assert.deepEqual(await snapshot(discoveryRoot), unpublishedBefore)
  const published = executionRecord(await request('runStateListen', {
    stateId, directory, binding, sourceSha256, deadline: Date.now() + 120_000,
  })).record
  // Only the retained, joined run may read the selected controller inbox.
  const inboxRequest = { stateId, directory, teamId: binding.teamId, runId: binding.runId,
    root: selectedRoot, databasePath, sha256: selectedHash }
  const readInbox = () => request('runStateReadControllerInbox', inboxRequest)
  const expectedInbox = { schema: 1, ok: true, state: 'regular',
    bytesBase64: Buffer.from(inboxContent).toString('base64') }
  assert.deepEqual(await readInbox(), expectedInbox)
  for (const changed of [
    { runId: 'TEST-foreign-run' }, { teamId: 'TEST-foreign-team' },
    { root: selectedRoot + '-foreign' }, { databasePath: databasePath + '-foreign' },
    { sha256: '0'.repeat(64) },
  ]) await assert.rejects(request('runStateReadControllerInbox', { ...inboxRequest, ...changed }),
    /run_controller_inbox_unknown|run_state_start_changed/)
  const userInbox = path.win32.join(inboxes, 'user.json')
  const originalInbox = path.win32.join(inboxes, 'TEST-original-user.json')
  await rename(userInbox, originalInbox)
  assert.deepEqual(await readInbox(), { schema: 1, ok: true, state: 'absent', bytesBase64: null })
  const aliasTarget = path.win32.join(requestedRoot, 'TEST-inbox-alias-target')
  retain(await filesystem.createDirectory(aliasTarget))
  await symlink(aliasTarget, userInbox, 'junction')
  assert.equal((await lstat(userInbox)).isSymbolicLink(), true)
  await assert.rejects(readInbox(), /run_controller_inbox_unknown/)
  // Retain each attack fixture separately; restore only the original TEST file.
  await rename(userInbox, path.win32.join(requestedRoot, 'TEST-inbox-reparse-evidence'))
  await writeFile(userInbox, Buffer.alloc(4 * 1024 * 1024 + 1), { flag: 'wx', mode: 0o600 })
  await assert.rejects(readInbox(), /run_controller_inbox_unknown/)
  await rename(userInbox, path.win32.join(inboxes, 'TEST-oversize-user.json'))
  await rename(originalInbox, userInbox)
  assert.deepEqual(await readInbox(), expectedInbox)
  facts.joinedControllerInboxRead = { exactBytes: true, positiveAbsence: true,
    foreignRunTeamProfileDatabaseAndConfigRefused: true, reparseRefused: true, oversizeRefused: true,
    originalReadRestored: true }
  const statusResponses = new Set<Promise<void>>()
  const statusFailures: unknown[] = []
  let statusRequests = 0
  let withholdNextStatus = false
  let heldConnection: string | undefined
  const respondToStatus = (event: unknown) => {
    const work = (async () => {
      const envelope = executionRecord(event), payload = executionRecord(envelope.payload)
      assert.equal(payload.protocol, 1)
      assert.deepEqual(payload.binding, binding)
      assert.equal(executionRecord(payload.request).operation, 'status')
      statusRequests++
      if (withholdNextStatus) {
        withholdNextStatus = false
        assert.equal(typeof envelope.connection, 'string')
        heldConnection = String(envelope.connection)
        return // The authenticated frame arrived; deliberately withhold only its reply.
      }
      if (heldConnection !== undefined) {
        await request('runStatePoisonConnection', { stateId, directory, connection: heldConnection })
        heldConnection = undefined
      }
      await request('runStateRespond', { stateId, directory, connection: envelope.connection,
        timeoutMs: Math.max(1, Math.min(5000, Number(payload.deadline) - Date.now())),
        response: { nonce: payload.nonce, endpoint: payload.endpoint,
          result: { kind: 'status', state: 'stopped', members: [], deadline: executionRecord(published).deadline } } })
    })().catch(error => { statusFailures.push(error) }).finally(() => { statusResponses.delete(work) })
    statusResponses.add(work)
  }
  broker.events.on('runControlRequest', respondToStatus)
  try {
    // A published owner must survive idle ticks before and between fresh peers.
    await new Promise(resolve => setTimeout(resolve, 2500))
    await route(discoveryRoot, binding.runId, 'owner', 'unsupported', published)
    await new Promise(resolve => setTimeout(resolve, 2500))
    await route(discoveryRoot, binding.runId, 'owner', 'missing', published)
    // Fresh authenticated peers contend for this one original published owner.
    await Promise.all(Array.from({ length: 3 }, () =>
      route(discoveryRoot, binding.runId, 'owner', 'missing', published)))
    facts.concurrentFreshStatusPeers = 3
    const repeated = await route(discoveryRoot, binding.runId, 'owner', 'missing', published, false, 65)
    assert.equal(repeated.statusBatch, 65)
    facts.sameClientSequentialStatuses = 65
    withholdNextStatus = true
    const recovered = await route(discoveryRoot, binding.runId, 'owner', 'missing', published, true)
    assert.equal(recovered.heldReadRetired, true)
    assert.equal(recovered.sameClientRecovered, true)
    assert.equal(withholdNextStatus, false)
    assert.equal(heldConnection, undefined)
    facts.authenticatedReadTimeoutRetiresAndSameClientRecovers = true
  } finally {
    broker.events.off('runControlRequest', respondToStatus)
    await Promise.all(statusResponses)
  }
  assert.deepEqual(statusFailures, [])
  assert.equal(statusRequests, 72)
  // Use the actual native-sealed nonce, never a mocked cohort or caller-chosen
  // member identity. These ACL fixtures exercise admission, not a member launch;
  // the source integration probe covers the native launch's actual grants.
  const sealedLaunchNonce = async (runDirectory: string) => {
    const start = executionRecord(JSON.parse(await readFile(path.win32.join(runDirectory, 'start.json'), 'utf8')))
    const members = executionRecord(start.cohort).members
    assert.ok(Array.isArray(members) && members.length === 1)
    const nonce = executionRecord(members[0]).launchNonce
    assert.equal(typeof nonce, 'string'); assert.match(String(nonce), /^[a-f0-9-]{36}$/)
    return String(nonce)
  }
  const deriveMetadataSids = async (launchNonce: string) => executionRecord(JSON.parse(await powershell('appcontainer_sid_derivation', `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class TestRunMetadataSid {
[DllImport("userenv.dll",CharSet=CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
[DllImport("advapi32.dll")] public static extern IntPtr FreeSid(IntPtr sid);
}
'@
function Derive([string]$nonce){$native=[IntPtr]::Zero
if([TestRunMetadataSid]::DeriveAppContainerSidFromAppContainerName(('AgentTeams.OpenCodeV2.'+$nonce),[ref]$native)-ne 0){throw 'TEST SID derivation failed'}
try{return [Security.Principal.SecurityIdentifier]::new($native).Value}finally{[TestRunMetadataSid]::FreeSid($native)|Out-Null}}
[Console]::Write((@{member=(Derive $env:TEST_LAUNCH_NONCE);stale=(Derive ([guid]::NewGuid().ToString()))}|ConvertTo-Json -Compress))
`, directory, { TEST_LAUNCH_NONCE: launchNonce })))
  const metadataSids = await deriveMetadataSids(await sealedLaunchNonce(directory))
  assert.match(String(metadataSids.member), /^S-1-15-2-/)
  assert.match(String(metadataSids.stale), /^S-1-15-2-/)
  assert.notEqual(metadataSids.member, metadataSids.stale)
  const endpointHash = executionHash(published)
  const validateEndpoint = async () => {
    const result = executionRecord(await request('runStateValidateEndpoint', { stateId, directory, endpointHash }))
    assert.equal(result.valid, true); assert.equal(result.endpointHash, endpointHash)
  }
  const privateMetadataDenied = (error: unknown) => error instanceof Error &&
    /^execution_owner_not_private(?::private_acl_foreign_allow:\d+)?$/.test(error.message)
  const metadataBefore = await snapshot(discoveryRoot)
  const fixtureSecurity = `
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class TestFixtureSecurity {
[DllImport("advapi32.dll",EntryPoint="SetFileSecurityW",ExactSpelling=true,CharSet=CharSet.Unicode,SetLastError=true)]
[return:MarshalAs(UnmanagedType.Bool)] public static extern bool SetFileSecurity(string path,uint information,byte[] descriptor);
[DllImport("advapi32.dll",EntryPoint="GetFileSecurityW",ExactSpelling=true,CharSet=CharSet.Unicode,SetLastError=true)]
[return:MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileSecurity(string path,uint information,[Out] byte[] descriptor,uint size,out uint needed);
public static byte[] ReadSecurityDescriptor(string path){
uint needed;
if(GetFileSecurity(path,7,null,0,out needed)||Marshal.GetLastWin32Error()!=122||needed==0||needed>131072)
throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
byte[] descriptor=new byte[(int)needed];uint actual;
if(!GetFileSecurity(path,7,descriptor,needed,out actual))
throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
if(actual!=needed)throw new System.InvalidOperationException("TEST raw descriptor size changed");
return descriptor;
}
}
'@
function Set-TestDacl([byte[]]$descriptor){
# DACL-only SetFileSecurityW does not propagate inheritable ACEs to children.
if(![TestFixtureSecurity]::SetFileSecurity($env:TEST_TARGET,4,$descriptor)){throw ('TEST ACL write failed:'+ [Runtime.InteropServices.Marshal]::GetLastWin32Error())}}
`
  const fixtureFailureCode = (error: unknown) => error instanceof Error &&
    /^[a-z_]{1,96}(?::[a-z_]{1,64}:\d{1,10})?$/.test(error.message) ? error.message
    : error instanceof assert.AssertionError ? 'assertion_failed' : 'fixture_operation_failed'
  const withMetadataAce = async (target: string, sid: string, rights: string, inheritance: string,
    verify: () => Promise<void>) => {
    // Capture/install together, then observe/restore together: two PowerShell
    // startups per fixture, without changing the published endpoint deadline.
    const fixture = executionRecord(JSON.parse(await powershell('metadata_acl_install', fixtureSecurity + `
$acl=Get-Acl -LiteralPath $env:TEST_TARGET
$original=$acl.Sddl;$descriptor=$acl.GetSecurityDescriptorBinaryForm()
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($env:TEST_SID),$env:TEST_RIGHTS,$env:TEST_INHERITANCE,'None','Allow'))
Set-TestDacl ($acl.GetSecurityDescriptorBinaryForm())
[Console]::Write((@{original=$original;descriptor=[Convert]::ToBase64String($descriptor);installed=(Get-Acl -LiteralPath $env:TEST_TARGET).Sddl}|ConvertTo-Json -Compress))`, target,
      { TEST_SID: sid, TEST_RIGHTS: rights, TEST_INHERITANCE: inheritance })))
    assert.equal(typeof fixture.original, 'string'); assert.equal(typeof fixture.descriptor, 'string')
    assert.equal(typeof fixture.installed, 'string')
    let verificationFailure: unknown
    try {
      await verify()
    } catch (error) {
      verificationFailure = error
      facts.metadataAclVerificationFailure = fixtureFailureCode(error)
      throw error
    } finally {
      let phase = 'observe_and_restore'
      try {
        const after = executionRecord(JSON.parse(await powershell('metadata_acl_restore', fixtureSecurity + `
try{$observed=(Get-Acl -LiteralPath $env:TEST_TARGET).Sddl}
finally{Set-TestDacl ([Convert]::FromBase64String($env:TEST_ORIGINAL_DESCRIPTOR));$restored=(Get-Acl -LiteralPath $env:TEST_TARGET).Sddl}
[Console]::Write((@{observed=$observed;restored=$restored}|ConvertTo-Json -Compress))`, target,
          { TEST_ORIGINAL_DESCRIPTOR: String(fixture.descriptor) })))
        phase = 'staged_acl_unchanged'; assert.equal(after.observed, fixture.installed)
        phase = 'restored_acl_exact'; assert.equal(after.restored, fixture.original)
      } catch (error) {
        facts.metadataAclFinalizationFailure = { phase, code: fixtureFailureCode(error) }
        if (verificationFailure !== undefined)
          throw new AggregateError([verificationFailure, error], 'TEST metadata verification and restoration failed')
        throw error
      }
    }
  }
  for (const target of [discoveryRoot, directory])
    await withMetadataAce(target, String(metadataSids.member), 'ReadAndExecute', 'None', validateEndpoint)
  for (const [sid, rights, inheritance] of [
    ['S-1-5-32-545', 'ReadAndExecute', 'None'],
    [String(metadataSids.stale), 'ReadAndExecute', 'None'],
    [String(metadataSids.member), 'Write', 'None'],
    [String(metadataSids.member), 'ReadAndExecute', 'ContainerInherit,ObjectInherit'],
  ]) {
    await withMetadataAce(directory, sid, rights, inheritance, async () => {
      await assert.rejects(validateEndpoint(), privateMetadataDenied)
    })
    await validateEndpoint()
  }
  // A previously launched cohort member adds RX metadata only to the
  // retained teams parent. Native inbox revalidation must accept precisely
  // that sealed member while keeping unrelated teams and broader ACEs closed.
  const controllerTeamsParent = path.win32.join(claudeRoot, 'teams')
  const readExactControllerInbox = async () => { assert.deepEqual(await readInbox(), expectedInbox) }
  await withMetadataAce(controllerTeamsParent, String(metadataSids.member), 'ReadAndExecute', 'None', readExactControllerInbox)
  for (const [sid, rights, inheritance] of [
    ['S-1-5-32-545', 'ReadAndExecute', 'None'],
    [String(metadataSids.stale), 'ReadAndExecute', 'None'],
    [String(metadataSids.member), 'Write', 'None'],
    [String(metadataSids.member), 'ReadAndExecute', 'ContainerInherit,ObjectInherit'],
  ]) {
    await withMetadataAce(controllerTeamsParent, sid, rights, inheritance, async () => {
      await assert.rejects(readExactControllerInbox(), privateMetadataDenied)
    })
    await readExactControllerInbox()
  }
  facts.controllerTeamsParentMetadata = { sealedRxAccepted: true, foreignSidRefused: true,
    staleSidRefused: true, writeRefused: true, inheritanceRefused: true }
  // Fresh discovery reads the native-sealed start/cohort before control.json.
  // Even that exact member's metadata ACE must never authorize record files.
  await withMetadataAce(path.win32.join(directory, 'control.json'), String(metadataSids.member), 'ReadAndExecute', 'None',
    async () => { await route(discoveryRoot, binding.runId, 'veto') })
  await validateEndpoint()
  assert.deepEqual(await snapshot(discoveryRoot), metadataBefore)
  facts.runNamespaceMetadataAcl = { nativeSealedMemberTargetOnlyReadExecuteAccepted: true,
    foreignAndStaleSidRejected: true, memberWriteAndInheritanceRejected: true,
    controlRecordStillOwnerOnly: true, aclIdentityAndBytesUnchanged: true }
  // A second real native publisher supplies the other run's cohort and held
  // live owner witnesses. Only the shared namespace may admit its metadata SID.
  let foreignProjectCohortSid: string | undefined
  const concurrentBroker = createWindowsNativeBroker(helper)
  concurrentBroker.events.on('error', () => {})
  try {
    await concurrentBroker.request('ownerValidateSelectedProfile', { root: selectedRoot, databasePath,
      directories: [selectedRoot, selectedConfigDirectory] })
    const concurrentSelection = executionRecord(await concurrentBroker.request('ownerSelectConfig', {
      root: selectedRoot, databasePath, sha256: selectedHash, teamId: 'TEST-team' }))
    const concurrentBinding = { ...binding, runId: 'TEST-concurrent-cohort',
      controllerInstanceId: 'TEST-concurrent-controller', ownerId: 'TEST-concurrent-owner' }
    const concurrentDirectory = runControlDirectory(discoveryRoot, concurrentBinding.teamId, concurrentBinding.runId)
    const concurrentAcquired = executionRecord(await concurrentBroker.request('runStateAcquire', {
      dataRoot: discoveryRoot, directory: concurrentDirectory, binding: concurrentBinding,
      selectionIds: [String(concurrentSelection.selectionId)] }))
    const concurrentState = { stateId: String(concurrentAcquired.stateId), directory: concurrentDirectory }
    await concurrentBroker.request('runStateReserve', { ...concurrentState, binding: concurrentBinding,
      sourceSha256, sharedControllerRootCohort: true })
    const concurrentPublished = executionRecord(await concurrentBroker.request('runStateListen', {
      ...concurrentState, binding: concurrentBinding, sourceSha256, deadline: Date.now() + 120_000 })).record
    // These native reads enforce strict owner-only security on both records.
    for (const name of ['start.json', 'control.json'])
      await concurrentBroker.request('runStateReadRecord', { ...concurrentState, name })
    await concurrentBroker.request('runStateValidateEndpoint', {
      ...concurrentState, endpointHash: executionHash(concurrentPublished) })
    const concurrentSids = await deriveMetadataSids(await sealedLaunchNonce(concurrentDirectory))
    const concurrentSid = String(concurrentSids.member)
    foreignProjectCohortSid = concurrentSid
    assert.match(concurrentSid, /^S-1-15-2-/); assert.notEqual(concurrentSid, metadataSids.member)
    const concurrentBefore = await snapshot(discoveryRoot)
    await withMetadataAce(discoveryRoot, concurrentSid, 'ReadAndExecute', 'None', validateEndpoint)
    for (const [sid, rights, inheritance] of [
      [String(metadataSids.stale), 'ReadAndExecute', 'None'],
      [concurrentSid, 'Write', 'None'],
      [concurrentSid, 'ReadAndExecute', 'ContainerInherit,ObjectInherit'],
    ]) {
      await withMetadataAce(discoveryRoot, sid, rights, inheritance, async () => {
        await assert.rejects(validateEndpoint(), privateMetadataDenied)
      })
    }
    await withMetadataAce(directory, concurrentSid, 'ReadAndExecute', 'None', async () => {
      await assert.rejects(validateEndpoint(), privateMetadataDenied)
    })
    await concurrentBroker.close()
    assert.equal(concurrentBroker.ended(), true)
    await withMetadataAce(discoveryRoot, concurrentSid, 'ReadAndExecute', 'None', async () => {
      await assert.rejects(validateEndpoint(), privateMetadataDenied)
    })
    await validateEndpoint()
    assert.deepEqual(await snapshot(discoveryRoot), concurrentBefore)
    facts.concurrentRunNamespaceMetadataAcl = { independentNativeSealedCohortAndPublisher: true,
      nativeStartAndControlRecordsOwnerOnly: true, liveOtherRunSharedRootAccepted: true,
      sharedRootUnmatchedWriteAndInheritanceRejected: true, otherRunOwnLeafRejected: true,
      physicallyExitedOtherPublisherRejected: true,
      aclIdentityAndBytesUnchanged: true }
  } finally { await concurrentBroker.close() }
  // Same physical fence with a foreign requested binding must remain UNKNOWN.
  await assert.rejects(request('runStateDiscover', { dataRoot: discoveryRoot, directory,
    teamId: 'TEST-foreign', runId: binding.runId, selectionIds }), /run_state_start_changed/)
  const malformedRun = 'TEST-malformed-fence', malformedDirectory = runControlDirectory(discoveryRoot, 'TEST-team', malformedRun)
  const ownedMalformed = retain(await filesystem.createDirectory(malformedDirectory))
  await writeOwnedFixture(ownedMalformed, malformedDirectory, 'start.json', '{TEST-malformed\n')
  await route(discoveryRoot, malformedRun, 'veto')
  await request('runStateClose', { stateId, directory })
  facts.discoveryPresent = { unpublishedVeto: true, malformedFenceVeto: true, foreignBindingVeto: true,
    originalOwnerRecoveredAfterUnsupportedOrMissingCLI: true, originalEndpointMatched: true }
  const reparseInventoryRoot = path.win32.join(requestedRoot, 'TEST-reparse-profile-inventory')
  for (const directory of [reparseInventoryRoot, path.win32.join(reparseInventoryRoot, 'opencode'),
    path.win32.join(reparseInventoryRoot, 'opencode', 'v2'),
    path.win32.join(reparseInventoryRoot, 'opencode', 'v2', 'profiles')])
    retain(await filesystem.createDirectory(directory))
  const profileJunction = path.win32.join(reparseInventoryRoot, 'opencode', 'v2', 'profiles', 'TEST-junction')
  await symlink(selectedRoot, profileJunction, 'junction')
  const junctionBefore = await lstat(profileJunction)
  const profileBefore = await readFile(path.win32.join(selectedConfigDirectory, 'opencode.json'))
  await route(reparseInventoryRoot, 'TEST-fresh', 'veto')
  const junctionAfter = await lstat(profileJunction)
  assert.equal(junctionAfter.isSymbolicLink(), true)
  assert.equal(junctionAfter.ino, junctionBefore.ino)
  assert.equal(junctionAfter.dev, junctionBefore.dev)
  assert.deepEqual(await readFile(path.win32.join(selectedConfigDirectory, 'opencode.json')), profileBefore)
  facts.discoveryReparseProfileInventoryVeto = true
  const inboxRoot = path.win32.join(claudeRoot, "teams")
  for (const [team, state] of [["TEST-empty", "empty"], ["TEST-absent", "absent"]] as const) {
    retain(await filesystem.createDirectory(path.win32.join(inboxRoot, team)))
    const directory = path.win32.join(inboxRoot, team, "inboxes")
    const ownedDirectory = retain(await filesystem.createDirectory(directory))
    if (state === "absent") await writeOwnedFixture(ownedDirectory, directory, "other.json", "[]")
    assertConfigOnlySelection(await request("ownerSelectConfig", { root: selectedRoot, databasePath,
      sha256: createHash("sha256").update(selectedContent).digest("hex"), teamId: team }))
  }
  const oversizeTeam = "TEST-oversize"
  retain(await filesystem.createDirectory(path.win32.join(inboxRoot, oversizeTeam)))
  const oversizeDirectory = path.win32.join(inboxRoot, oversizeTeam, "inboxes")
  const ownedOversize = retain(await filesystem.createDirectory(oversizeDirectory))
  await writeOwnedFixture(ownedOversize, oversizeDirectory, "user.json", Buffer.alloc(4 * 1024 * 1024 + 1))
  assertConfigOnlySelection(await request("ownerSelectConfig", { root: selectedRoot, databasePath,
    sha256: createHash("sha256").update(selectedContent).digest("hex"), teamId: oversizeTeam }))
  // Complete malformed profiles must veto even a genuinely absent run; they
  // cannot be silently dropped to obtain the zero-selection absence path.
  const malformedProfile = path.win32.join(discoveryV2, 'profiles', 'TEST-malformed-profile')
  retain(await filesystem.createDirectory(malformedProfile))
  for (const name of ['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata'])
    retain(await filesystem.createDirectory(path.win32.join(malformedProfile, name)))
  const malformedConfigDirectory = path.win32.join(malformedProfile, 'config', 'opencode')
  const malformedConfig = retain(await filesystem.createDirectory(malformedConfigDirectory))
  retain(await filesystem.createDirectory(path.win32.join(malformedProfile, 'data', 'opencode')))
  await writeOwnedFixture(malformedConfig, malformedConfigDirectory, 'opencode.json', '{TEST-malformed')
  await route(discoveryRoot, 'TEST-fresh', 'veto')
  facts.malformedCompleteProfileVeto = true
  // Two actual AppContainers join one original native seal and overlap on only
  // its selected project. A third sealed row selects another project and never
  // launches: membership alone must not authorize its SID on this project.
  const projectDataRoot = path.win32.join(requestedRoot, 'TEST-project-cohort-data')
  const sharedProject = path.win32.join(requestedRoot, 'TEST-project-cohort-shared')
  const otherProject = path.win32.join(requestedRoot, 'TEST-project-cohort-other')
  const projectController = path.win32.join(requestedRoot, 'TEST-project-cohort-controller')
  const projectTeam = 'TEST-project-cohort'
  const projectBinding = { teamId: projectTeam, runId: 'TEST-project-cohort-run',
    controllerInstanceId: 'TEST-project-controller', ownerId: 'TEST-project-owner' }
  const projectBroker = createWindowsNativeBroker(helper)
  projectBroker.events.on('error', () => {})
  const projectFilesystem = createWindowsOwnerFilesystem(input => projectBroker.request(input.op, input))
  const peers: Array<{ broker: ReturnType<typeof createWindowsNativeBroker>; fence?: WindowsOwnerDirectory;
    mapping?: Record<string, unknown>; mainExited?: Record<string, unknown>; connected?: Record<string, unknown>;
    messages: Record<string, unknown>[]; retired: boolean }> = []
  let projectState: { stateId: string; directory: string } | undefined
  let projectBaseline: Array<Record<string, unknown>> | undefined
  let projectGrantedBaseline: Array<Record<string, unknown>> | undefined
  let projectOriginalIdentity: { dev: number; ino: number; birth: number } | undefined
  const projectControlAfterOwnWrite = (before: unknown, after: unknown) => before === after ||
    ((before === 0x8004 || before === 0x9004) && after === (Number(before) | 0x400))
  const projectControlAfterFixtureWrite = (before: unknown, after: unknown) =>
    Number.isSafeInteger(before) && Number(before) >= 0 && Number(before) <= 0xffff &&
    Number.isSafeInteger(after) && Number(after) >= 0 && Number(after) <= 0xffff &&
    (Number(before) & 4) === 4 && (Number(after) & 4) === 4 &&
    (before === after ||
      (before === 0x9404 && after === 0x9004) || (before === 0x9004 && after === 0x9404) ||
      (before === 0x8404 && after === 0x8004) || (before === 0x8004 && after === 0x8404))
  const assertRestoredProjectAcl = (before: unknown, after: unknown) => {
    const original = executionRecord(before), restored = executionRecord(after)
    assert.ok(typeof original.owner === 'string' && original.owner === restored.owner, 'TEST_project_acl_owner_changed')
    assert.ok(typeof original.group === 'string' && original.group === restored.group, 'TEST_project_acl_group_changed')
    assert.ok(typeof original.dacl === 'string' && original.dacl === restored.dacl, 'TEST_project_acl_bytes_changed')
    // SetFileSecurityW can clear AUTO_INHERITED; SetSecurityInfo can add it.
    // Only the already-observed finite pairs are accepted after our own writes.
    assert.ok(projectControlAfterFixtureWrite(original.control, restored.control), 'TEST_project_acl_control_changed')
  }
  const projectControlFact = (value: unknown): number | null =>
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff ? Number(value) : null
  const projectAclRestorations: Array<{ beforeControl: number | null; afterControl: number | null;
    ownerUnchanged: boolean; groupUnchanged: boolean; daclBytesUnchanged: boolean; identityUnchanged: boolean }> = []
  facts.projectAclRestorations = projectAclRestorations
  const projectAcl = async (includeDacl = false): Promise<Array<Record<string, unknown>>> => {
    const rows = JSON.parse(await powershell('project_acl_snapshot', fixtureSecurity + `
$rows=@(foreach($item in @((Get-Item -LiteralPath $env:TEST_TARGET);(Get-ChildItem -LiteralPath $env:TEST_TARGET -Recurse -Force | Sort-Object FullName))){
$raw=[Security.AccessControl.RawSecurityDescriptor]::new([TestFixtureSecurity]::ReadSecurityDescriptor($item.FullName),0)
$daclBytes=[byte[]]::new($raw.DiscretionaryAcl.BinaryLength);$raw.DiscretionaryAcl.GetBinaryForm($daclBytes,0)
$aces=@(foreach($ace in $raw.DiscretionaryAcl){
if($ace -isnot [Security.AccessControl.CommonAce]){throw 'TEST unexpected project ACE'}
$bytes=[byte[]]::new($ace.BinaryLength);$ace.GetBinaryForm($bytes,0)
[ordered]@{sid=$ace.SecurityIdentifier.Value;mask=$ace.AccessMask;flags=[int]$ace.AceFlags;type=[int]$ace.AceType;bytes=[Convert]::ToBase64String($bytes)}})
[ordered]@{relative=$item.FullName.Substring($env:TEST_TARGET.Length);owner=$raw.Owner.Value;group=$raw.Group.Value;control=[int]$raw.ControlFlags;dacl=[Convert]::ToBase64String($daclBytes);aces=$aces}})
[Console]::Write((ConvertTo-Json -InputObject $rows -Depth 5 -Compress))`, sharedProject)) as Array<Record<string, unknown>>
    return includeDacl ? rows : rows.map(({ dacl, ...row }) => row)
  }
  const rootIdentity = async () => { const info = await lstat(sharedProject); return { dev: info.dev, ino: info.ino, birth: info.birthtimeMs } }
  const lowerProjectIntegrity = async () => {
    assert.ok(process.env.SystemRoot && path.win32.isAbsolute(process.env.SystemRoot))
    const executable = path.win32.join(process.env.SystemRoot, 'System32', 'icacls.exe')
    const countOutput = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader(); let bytes = 0
      for (;;) { const part = await reader.read(); if (part.done) return bytes; bytes += part.value.byteLength }
    }
    for (const [index, target] of [sharedProject, projectDataRoot, otherProject].entries()) {
      let operation: 'spawn' | 'output_read' | 'exit' = 'spawn'
      let exitCode: number | null = null, stdoutBytes: number | null = null, stderrBytes: number | null = null
      try {
        // Bypass PowerShell's native-command activation entirely. Invoke only
        // the exact system image and these three fresh TEST roots.
        const child = Bun.spawn([executable, target, '/setintegritylevel', '(OI)(CI)L', '/T', '/Q'], {
          env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
          stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        })
        operation = 'output_read'
        const [stdout, stderr, exit] = await Promise.allSettled([
          countOutput(child.stdout), countOutput(child.stderr), child.exited,
        ])
        if (exit.status === 'fulfilled') exitCode = exit.value
        if (stdout.status === 'fulfilled') stdoutBytes = stdout.value
        if (stderr.status === 'fulfilled') stderrBytes = stderr.value
        for (const result of [stdout, stderr, exit]) if (result.status === 'rejected') throw result.reason
        operation = 'exit'
        assert.equal(exitCode, 0, 'TEST_project_low_integrity_failed')
      } catch (error) {
        const failure: Partial<NodeJS.ErrnoException> = error !== null && typeof error === 'object' ? error : {}
        const codes = ['E2BIG', 'EACCES', 'EBADF', 'EBUSY', 'EFAULT', 'EINVAL', 'EIO', 'EMFILE',
          'ENAMETOOLONG', 'ENFILE', 'ENOENT', 'ENOEXEC', 'ENOMEM', 'ENOTDIR', 'EPERM', 'EPIPE', 'UNKNOWN']
        facts.projectLowIntegrityFailure = { rootIndex: index, operation, exitCode, stdoutBytes, stderrBytes,
          spawnErrno: codes.find(code => code === failure.code) ?? null,
          errno: Number.isSafeInteger(failure.errno) && Number(failure.errno) >= -0x80000000 &&
            Number(failure.errno) <= 0x7fffffff ? Number(failure.errno) : null }
        throw new Error('TEST_project_low_integrity_failed')
      }
    }
    facts.projectLowIntegrityRoots = 3
  }
  const waitProjectPeer = async <T>(read: () => T | undefined): Promise<T> => {
    const deadline = Date.now() + 10_000
    for (;;) { const value = read(); if (value !== undefined) return value
      assert.ok(Date.now() < deadline, 'TEST_project_peer_timeout'); await Bun.sleep(10) }
  }
  let projectProofFailure: unknown
  const projectCleanupFailures: string[] = []
  try {
    facts.projectCohortStage = 'setup'
    for (const target of [projectDataRoot, path.win32.join(projectDataRoot, 'opencode'),
      path.win32.join(projectDataRoot, 'opencode', 'v2'),
      path.win32.join(projectDataRoot, 'opencode', 'v2', 'profiles'),
      path.win32.join(projectDataRoot, 'opencode', 'v2', 'runs'),
      sharedProject, otherProject, projectController, path.win32.join(projectController, 'teams'),
      path.win32.join(projectController, 'teams', projectTeam),
      path.win32.join(projectController, 'teams', projectTeam, 'inboxes'),
      path.win32.join(projectController, 'tasks'), path.win32.join(projectController, 'tasks', projectTeam)]) {
      const created = await projectFilesystem.createDirectory(target); await created.close()
    }
    const config = JSON.stringify({ mcpServers: { 'agent-teams': { type: 'local',
      env: { AGENT_TEAMS_MCP_CLAUDE_DIR: projectController } } } })
    const sha256 = createHash('sha256').update(config).digest('hex')
    const profiles = []
    for (const name of ['first', 'second', 'other-project']) {
      const root = path.win32.join(projectDataRoot, 'opencode', 'v2', 'profiles', 'TEST-' + name)
      const directories = [root, ...['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata',
        'config/opencode', 'data/opencode'].map(value => path.win32.join(root, value))]
      for (const target of directories.slice(0, -2)) { const created = await projectFilesystem.createDirectory(target); await created.close() }
      const heldConfig = await projectFilesystem.createDirectory(path.win32.join(root, 'config', 'opencode'))
      try { await heldConfig.writePreparedConfig(config, sha256) } finally { await heldConfig.close() }
      const heldData = await projectFilesystem.createDirectory(path.win32.join(root, 'data', 'opencode'))
      try {
        await heldData.writePreparedAuth(authContent, authHash)
        await heldData.createPreparedDatabase()
      } finally { await heldData.close() }
      const profile = { root, databasePath: path.win32.join(root, 'data', 'opencode', 'opencode.db'),
        directories, projectDirectory: name === 'other-project' ? otherProject : sharedProject, sha256 }
      const validated = executionRecord(await projectBroker.request('ownerValidateSelectedProfile', {
        root, databasePath: profile.databasePath, directories, projectDirectory: profile.projectDirectory }))
      const selected = executionRecord(await projectBroker.request('ownerSelectConfig', {
        root, databasePath: profile.databasePath, sha256, teamId: projectTeam }))
      profiles.push({ ...profile, rootIdentity: validated.rootIdentity, selectionId: String(selected.selectionId) })
    }
    await copyFile(process.execPath, path.win32.join(sharedProject, 'bun.exe'))
    await writeFile(path.win32.join(sharedProject, 'main.ts'), `
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
    await writeFile(path.win32.join(sharedProject, 'project-command.ts'), `
const fs=await import('node:fs/promises'),path=await import('node:path')
const actor=process.env.TEST_PROJECT_MEMBER!,peer=process.env.TEST_PROJECT_PEER
if(!['first','second'].includes(actor))throw Error('TEST_project_member_invalid')
if(peer&&await fs.readFile(path.join(process.cwd(),peer+'.txt'),'utf8')!==peer)throw Error('TEST_project_peer_file_invalid')
await fs.writeFile(path.join(process.cwd(),actor+'.txt'),actor)
await Bun.stdout.write(actor+':written')
`)
    facts.projectCohortStage = 'project_low_integrity'
    await lowerProjectIntegrity()
    const beforeIdentity = await rootIdentity()
    projectOriginalIdentity = beforeIdentity; projectBaseline = await projectAcl()
    const beforeAcl = projectBaseline[0]!
    const directory = runControlDirectory(projectDataRoot, projectTeam, projectBinding.runId)
    facts.projectCohortStage = 'run_state_acquire'
    const acquired = executionRecord(await projectBroker.request('runStateAcquire', {
      dataRoot: projectDataRoot, directory, binding: projectBinding,
      selectionIds: profiles.map(profile => profile.selectionId) }))
    projectState = { stateId: String(acquired.stateId), directory }
    facts.projectCohortStage = 'run_state_reserve'
    await projectBroker.request('runStateReserve', { ...projectState, binding: projectBinding,
      sourceSha256, sharedControllerRootCohort: true })
    facts.projectCohortStage = 'run_state_listen'
    await projectBroker.request('runStateListen', { ...projectState, binding: projectBinding,
      sourceSha256, deadline: Date.now() + 120_000 })
    facts.projectCohortStage = 'sealed_rows'
    const sealed = executionRecord(JSON.parse(await readFile(path.win32.join(directory, 'start.json'), 'utf8')))
    const rows = executionRecord(sealed.cohort).members
    assert.ok(Array.isArray(rows) && rows.length === 3)
    const memberRows = profiles.map(profile => {
      const matches = rows.map(executionRecord).filter(row =>
        executionHash(executionRecord(row.profile).root) === executionHash(profile.rootIdentity))
      assert.equal(matches.length, 1)
      const member = matches[0]!
      assert.equal(typeof member.launchNonce, 'string')
      assert.equal(executionRecord(member.config).sha256, sha256)
      return member
    })
    assert.equal(new Set(memberRows.map(row => row.launchNonce)).size, 3)
    assert.deepEqual(memberRows[0]!.projectRoot, memberRows[1]!.projectRoot)
    assert.notDeepEqual(memberRows[0]!.projectRoot, memberRows[2]!.projectRoot)
    const otherSid = String((await deriveMetadataSids(String(memberRows[2]!.launchNonce))).member)
    assert.ok(foreignProjectCohortSid)
    // A different captured CWD cannot select the original sealed member.
    const wrongProjectBroker = createWindowsNativeBroker(helper)
    wrongProjectBroker.events.on('error', () => {})
    try {
      facts.projectCohortStage = 'wrong_project_preflight'
      const profile = profiles[1]!
      await wrongProjectBroker.request('ownerValidateSelectedProfile', { root: profile.root,
        databasePath: profile.databasePath, directories: profile.directories, projectDirectory: otherProject })
      const before = await projectAcl()
      await assert.rejects(wrongProjectBroker.request('runStateSelect', { mode: 'memberPreflight',
        dataRoot: projectDataRoot, directory, binding: projectBinding,
        root: profile.root, databasePath: profile.databasePath, sha256 }), /run_state_start_changed/)
      assert.deepEqual(await projectAcl(), before); assert.deepEqual(await rootIdentity(), beforeIdentity)
    } finally { await wrongProjectBroker.close() }
    const memberSids: string[] = []
    for (const [index, profile] of profiles.slice(0, 2).entries()) {
      facts.projectCohortStage = index === 0 ? 'first_member' : 'second_member'
      const peer = { broker: createWindowsNativeBroker(helper), messages: [] as Record<string, unknown>[],
        retired: false } as (typeof peers)[number]
      peers.push(peer); peer.broker.events.on('error', () => {})
      peer.broker.events.on('message', value => peer.messages.push(executionRecord(value)))
      peer.broker.events.on('connected', value => { peer.connected = executionRecord(value) })
      peer.broker.events.on('mainExited', value => { peer.mainExited = executionRecord(value) })
      const filesystem = createWindowsOwnerFilesystem(input => peer.broker.request(input.op, input))
      await peer.broker.request('ownerValidateSelectedProfile', { root: profile.root,
        databasePath: profile.databasePath, directories: profile.directories, projectDirectory: profile.projectDirectory })
      const preflight = executionRecord(await peer.broker.request('runStateSelect', { mode: 'memberPreflight',
        dataRoot: projectDataRoot, directory, binding: projectBinding,
        root: profile.root, databasePath: profile.databasePath, sha256 }))
      assert.equal(preflight.launchNonce, memberRows[index]!.launchNonce)
      const selected = executionRecord(await peer.broker.request('ownerSelectConfig', {
        root: profile.root, databasePath: profile.databasePath, sha256, teamId: projectTeam }))
      const fencePath = path.win32.join(profile.root, '.native-project-owner')
      peer.fence = await filesystem.createDirectory(fencePath)
      const leaseOwnerId = randomUUID(), nonce = String(preflight.launchNonce)
      await peer.fence.writeExclusive('owner.json', { schema: 1, testOnly: true, nonce, leaseOwnerId })
      const environment = { SystemRoot: process.env.SystemRoot!, WINDIR: process.env.WINDIR!,
        PATH: sharedProject + ';' + path.win32.join(process.env.SystemRoot!, 'System32'),
        HOME: path.win32.join(profile.root, 'home'), USERPROFILE: path.win32.join(profile.root, 'home'),
        LOCALAPPDATA: path.win32.join(profile.root, 'localappdata'), TEMP: path.win32.join(profile.root, 'tmp'),
        TMP: path.win32.join(profile.root, 'tmp'), PWD: sharedProject }
      peer.mapping = executionRecord(await peer.broker.request('launch', {
        executable: path.win32.join(sharedProject, 'bun.exe'), entry: path.win32.join(sharedProject, 'main.ts'),
        cwd: sharedProject, env: environment, writableRoots: [sharedProject, profile.root], readOnlyRoots: [],
        protectedRoots: [fencePath], nonce, leaseOwnerId, selectedConfigId: String(selected.selectionId) }))
      const main = executionRecord(peer.mapping.bun)
      const connected = await waitProjectPeer(() => peer.connected)
      assert.deepEqual(connected, { ...peer.mapping, clientPID: main.nativePID })
      await peer.broker.request('send', { value: { type: 'prepare', nonce, leaseOwnerId,
        birth: main.birth, namespace: peer.mapping.namespace } })
      const prepared = await waitProjectPeer(() => peer.messages.find(value => value.type === 'prepared'))
      assert.equal(prepared.pid, main.nativePID); assert.equal(prepared.nonce, nonce)
      assert.equal(prepared.leaseOwnerId, leaseOwnerId); assert.deepEqual(prepared.birth, main.birth)
      assert.equal(prepared.namespace, peer.mapping.namespace)
      memberSids.push(String(peer.mapping.containerSid))
      const commandId = randomUUID(), actor = index === 0 ? 'first' : 'second'
      const command = executionRecord(await peer.broker.request('commandStart', { commandId,
        executable: path.win32.join(sharedProject, 'bun.exe'), args: [path.win32.join(sharedProject, 'project-command.ts')],
        cwd: sharedProject, env: { ...environment, TEST_PROJECT_MEMBER: actor, TEST_PROJECT_PEER: index ? 'first' : '' },
        stdin: 'ignore' }))
      assert.equal(command.commandId, commandId)
      const output = async (stream: 'stdout' | 'stderr') => {
        let offset = 0; const chunks: Buffer[] = []
        const deadline = Date.now() + 10_000
        for (;;) {
          assert.ok(Date.now() < deadline, 'TEST_project_command_timeout')
          const value = executionRecord(await peer.broker.request('commandRead', { commandId, stream, offset, maxBytes: 8192 }))
          const bytes = Buffer.from(String(value.bytesBase64), 'base64')
          assert.equal(bytes.toString('base64'), value.bytesBase64); assert.equal(value.nextOffset, offset + bytes.length)
          offset += bytes.length; assert.ok(offset <= 65536); chunks.push(bytes)
          if (value.eof === true) return Buffer.concat(chunks)
          await Bun.sleep(10)
        }
      }
      const [stdout, stderr] = await Promise.all([output('stdout'), output('stderr')])
      assert.equal(stdout.toString(), actor + ':written'); assert.equal(stderr.length, 0)
      const retired = executionRecord(await peer.broker.request('commandRetire', { commandId }))
      assert.equal(retired.empty, true); assert.equal(retired.activeProcesses, 0); assert.equal(retired.heldProcessExited, true)
      assert.equal(executionRecord(await peer.broker.request('commandClose', { commandId })).closed, true)
      assert.equal(await readFile(path.win32.join(sharedProject, actor + '.txt'), 'utf8'), actor)
      for (const member of peers) assert.deepEqual(await member.broker.request('assertLive'), member.mapping)
    }
    assert.notEqual(memberSids[0], memberSids[1])
    for (const sid of memberSids) assert.notEqual(sid, otherSid)
    facts.projectCohortStage = 'granted_acl'
    projectGrantedBaseline = await projectAcl()
    const granted = projectGrantedBaseline[0]!
    const projectAces = (granted.aces as unknown[]).map(executionRecord)
    for (const sid of memberSids) {
      const matching = projectAces.filter(ace => ace.sid === sid)
      assert.equal(matching.length, 1); assert.equal(matching[0]!.mask, 0x1301bf)
      assert.equal(matching[0]!.flags, 3); assert.equal(matching[0]!.type, 0)
    }
    // SetSecurityInfo may add only AUTO_INHERITED during our own write. Pin
    // the resulting controls; negative checks below still compare exactly.
    assert.ok(projectControlAfterOwnWrite(beforeAcl.control, granted.control))
    assert.deepEqual({ ...granted, aces: projectAces.filter(ace => !memberSids.includes(String(ace.sid))) },
      { ...beforeAcl, control: granted.control })
    for (const original of projectBaseline) {
      const actual = projectGrantedBaseline.find(row => row.relative === original.relative)
      assert.ok(actual); assert.ok(projectControlAfterOwnWrite(original.control, actual.control))
      assert.deepEqual({ ...actual, aces: (actual.aces as unknown[]).map(executionRecord)
        .filter(ace => !memberSids.includes(String(ace.sid))) }, { ...original, control: actual.control })
    }
    // Mutate only the target DACL, never propagate a synthetic ACE. Every
    // refusal must preserve the installed tree and the original physical pin.
    let duplicateOutcome: 'duplicate_refused' | 'duplicate_normalized_before_admission' | undefined
    for (const [sid, mask, flags, replace] of [
      [foreignProjectCohortSid, 0x1301bf, 3, false],
      [otherSid, 0x1301bf, 3, false],
      [memberSids[0]!, 0x1f01ff, 3, true],
      [memberSids[0]!, 0x1301bf, 0, true],
      [memberSids[0]!, 0x1301bf, 3, false],
    ] as const) {
      facts.projectCohortStage = replace ? mask === 0x1f01ff ? 'broad_mask_refusal' : 'inheritance_refusal'
        : sid === otherSid ? 'other_project_sid_refusal'
          : sid === foreignProjectCohortSid ? 'foreign_cohort_sid_refusal' : 'duplicate_ace_refusal'
      const duplicateFixture = !replace && sid === memberSids[0] && mask === 0x1301bf && flags === 3
      const original = executionRecord(JSON.parse(await powershell('project_acl_install', fixtureSecurity + `
$bytes=[TestFixtureSecurity]::ReadSecurityDescriptor($env:TEST_TARGET);$raw=[Security.AccessControl.RawSecurityDescriptor]::new($bytes,0)
$daclBytes=[byte[]]::new($raw.DiscretionaryAcl.BinaryLength);$raw.DiscretionaryAcl.GetBinaryForm($daclBytes,0)
$security=[ordered]@{owner=$raw.Owner.Value;group=$raw.Group.Value;control=[int]$raw.ControlFlags;dacl=[Convert]::ToBase64String($daclBytes)}
$sid=[Security.Principal.SecurityIdentifier]::new($env:TEST_SID)
$indices=@(for($i=0;$i-lt $raw.DiscretionaryAcl.Count;$i++){if($raw.DiscretionaryAcl[$i].SecurityIdentifier.Value-eq $sid.Value){$i}})
$index=$raw.DiscretionaryAcl.Count
if($env:TEST_REPLACE-eq 'true'){if($indices.Count-ne 1){throw 'TEST project ACE missing'};$index=$indices[0];$raw.DiscretionaryAcl.RemoveAce($index)}
$ace=[Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags][int]$env:TEST_FLAGS,[Security.AccessControl.AceQualifier]::AccessAllowed,[int]$env:TEST_MASK,$sid,$false,$null)
$raw.DiscretionaryAcl.InsertAce($index,$ace)
$changed=[byte[]]::new($raw.BinaryLength);$raw.GetBinaryForm($changed,0);Set-TestDacl $changed
[Console]::Write((@{descriptor=[Convert]::ToBase64String($bytes);security=$security}|ConvertTo-Json -Compress))`, sharedProject,
        { TEST_SID: sid, TEST_MASK: String(mask), TEST_FLAGS: String(flags), TEST_REPLACE: String(replace) })))
      let verificationFailure: unknown
      let verificationPhase = 'staged_acl_snapshot'
      let verificationMember: number | null = null
      try {
        const staged = await projectAcl(true)
        const matching = (staged[0]!.aces as unknown[]).map(executionRecord).filter(ace => ace.sid === sid)
        if (duplicateFixture) {
          verificationPhase = 'duplicate_native_precondition'
          assert.ok(matching.length === 1 || matching.length === 2)
          for (const ace of matching) { assert.equal(ace.type, 0); assert.equal(ace.mask, 0x1301bf); assert.equal(ace.flags, 3) }
        }
        if (duplicateFixture && matching.length === 1) {
          // Some setters normalize equivalent ACEs. This is live acceptance
          // only when the complete native DACL is exactly the original one.
          verificationPhase = 'duplicate_normalized_before_admission'
          assertRestoredProjectAcl(original.security, staged[0])
          assert.deepEqual(await rootIdentity(), beforeIdentity)
          for (const [index, peer] of peers.entries()) {
            verificationMember = index
            assert.ok(executionHash(await peer.broker.request('assertLive')) === executionHash(peer.mapping),
              'TEST_project_normalized_mapping_changed')
          }
          duplicateOutcome = 'duplicate_normalized_before_admission'
        } else {
          if (duplicateFixture) assert.ok(typeof matching[0]!.bytes === 'string' && matching[0]!.bytes === matching[1]!.bytes,
            'TEST_project_duplicate_ace_bytes_changed')
          verificationPhase = 'member_refusal'
          for (const [index, peer] of peers.entries()) {
            verificationMember = index
            await assert.rejects(peer.broker.request('assertLive'),
              /^Error: execution_containment_filesystem_denied(?::[a-z_]+:\d+)?$/)
          }
          if (duplicateFixture) duplicateOutcome = 'duplicate_refused'
        }
        verificationMember = null; verificationPhase = 'refusal_acl_unchanged'
        assert.ok(executionHash(await projectAcl(true)) === executionHash(staged), 'TEST_project_staged_acl_changed')
        verificationPhase = 'refusal_identity_unchanged'
        assert.deepEqual(await rootIdentity(), beforeIdentity)
      } catch (error) {
        verificationFailure = error
        facts.projectAclVerificationFailure = { stage: facts.projectCohortStage, phase: verificationPhase,
          memberIndex: verificationMember, code: fixtureFailureCode(error),
          actualNativeCode: error instanceof assert.AssertionError && error.actual instanceof Error
            ? fixtureFailureCode(error.actual) : null }
        throw error
      } finally {
        let phase = 'restore_write'
        try {
          const restored = executionRecord(JSON.parse(await powershell('project_acl_restore', fixtureSecurity + `
Set-TestDacl ([Convert]::FromBase64String($env:TEST_DESCRIPTOR))
$raw=[Security.AccessControl.RawSecurityDescriptor]::new([TestFixtureSecurity]::ReadSecurityDescriptor($env:TEST_TARGET),0)
$daclBytes=[byte[]]::new($raw.DiscretionaryAcl.BinaryLength);$raw.DiscretionaryAcl.GetBinaryForm($daclBytes,0)
[Console]::Write((@{owner=$raw.Owner.Value;group=$raw.Group.Value;control=[int]$raw.ControlFlags;dacl=[Convert]::ToBase64String($daclBytes)}|ConvertTo-Json -Compress))`,
            sharedProject, { TEST_DESCRIPTOR: String(original.descriptor) })))
          const security = executionRecord(original.security)
          const identityAfter = await rootIdentity()
          projectAclRestorations.push({ beforeControl: projectControlFact(security.control), afterControl: projectControlFact(restored.control),
            ownerUnchanged: security.owner === restored.owner, groupUnchanged: security.group === restored.group,
            daclBytesUnchanged: security.dacl === restored.dacl,
            identityUnchanged: executionHash(identityAfter) === executionHash(beforeIdentity) })
          phase = 'restore_security'
          assertRestoredProjectAcl(security, restored)
          phase = 'restore_identity'
          assert.deepEqual(identityAfter, beforeIdentity)
        } catch (error) {
          facts.projectAclRestorationFailure = { stage: facts.projectCohortStage, phase, code: fixtureFailureCode(error) }
          if (verificationFailure !== undefined)
            throw new AggregateError([verificationFailure, error], 'TEST_project_verification_and_restoration_failed')
          throw error
        }
      }
      // Invalid optional budgets must refuse before mutating the live Scope.
      const budgetPeer = peers[0]!
      await assert.rejects(budgetPeer.broker.request('retire', { deadline: Date.now() + 22_000, timeoutMs: 22_001 }), /cleanup_unknown/)
      assert.deepEqual(await budgetPeer.broker.request('assertLive'), budgetPeer.mapping)
      facts.retirementBudgetMalformedRefused = true
      for (const peer of peers) assert.deepEqual(await peer.broker.request('assertLive'), peer.mapping)
    }
    facts.selectedProjectCohort = { sealedMembers: 3, actualLaunchedMembers: 2, sharedProjectCommandsPassed: true,
      originalNativeNoncesUsed: true, wrongProjectPreflightRefused: true, foreignCohortRefused: true,
      sameCohortOtherProjectRefused: true, broadMaskRefused: true, inheritanceRefused: true,
      duplicateAceRefused: duplicateOutcome === 'duplicate_refused', duplicateAceOutcome: duplicateOutcome,
      refusalDaclAndIdentityUnchanged: true }
  } catch (error) {
    projectProofFailure = error
    facts.projectCohortFailure = fixtureFailureCode(error)
  }
  finally {
    // Neither broker closure nor a PID lookup substitutes for these original
    // mapping/held-main/empty-job/own-ACE retirement proofs.
    for (const peer of peers) {
      try {
        if (peer.mapping) {
          facts.projectCohortCleanupStage = 'member_retirement'
          const receipt = executionRecord(await peer.broker.request('retire'))
          assert.equal(receipt.empty, true); assert.equal(receipt.activeProcesses, 0)
          assert.equal(receipt.heldProcessExited, true); assert.equal(receipt.ownAcesRemoved, true)
          assert.deepEqual(receipt.mapping, peer.mapping)
          assert.equal(peer.mainExited?.heldProcessExited, true); assert.deepEqual(peer.mainExited?.mapping, peer.mapping)
          peer.retired = true
          const remaining = peers.filter(value => value.mapping && !value.retired)
          for (const live of remaining) assert.deepEqual(await live.broker.request('assertLive'), live.mapping)
        }
      } catch (error) { projectCleanupFailures.push(fixtureFailureCode(error)) }
      try { await peer.fence?.close() } catch (error) { projectCleanupFailures.push(fixtureFailureCode(error)) }
      try { await peer.broker.close() } catch (error) { projectCleanupFailures.push(fixtureFailureCode(error)) }
    }
    try { if (projectState) await projectBroker.request('runStateClose', projectState) }
    catch (error) { projectCleanupFailures.push(fixtureFailureCode(error)) }
    try { await projectBroker.close() } catch (error) { projectCleanupFailures.push(fixtureFailureCode(error)) }
    facts.projectCohortCleanupFailures = projectCleanupFailures
  }
  assert.deepEqual(projectCleanupFailures, [])
  if (projectProofFailure !== undefined) throw projectProofFailure
  assert.equal(peers.length, 2); assert.equal(peers.every(peer => peer.retired), true)
  const projectAfter = await projectAcl()
  const launchedSids = peers.map(peer => String(peer.mapping!.containerSid))
  for (const row of projectAfter)
    assert.equal((row.aces as unknown[]).map(executionRecord).some(ace => launchedSids.includes(String(ace.sid))), false)
  assert.ok(projectBaseline && projectGrantedBaseline && projectOriginalIdentity)
  for (const original of projectBaseline) {
    const granted = projectGrantedBaseline.find(row => row.relative === original.relative)!
    const after = projectAfter.find(row => row.relative === original.relative)
    assert.ok(after); assert.ok(projectControlAfterFixtureWrite(granted.control, after.control))
    assert.deepEqual(after, { ...original, control: after.control })
  }
  assert.deepEqual(await rootIdentity(), projectOriginalIdentity)
  Object.assign(executionRecord(facts.selectedProjectCohort), { bothPhysicalRetirementsProved: true,
    allOwnProjectAcesRemoved: true, originalOwnerGroupForeignAcesAndIdentityPreserved: true })
  Object.assign(facts, { archivedIdentity: before, archivedPath: successArchive,
    originalPathFreeForNewFence: true, nextIdentity: next.identity,
    noReplaceCollisionPreserved: true, partialFenceBlocksAcquisition: true,
    existingRecordNotOverwritten: true, readOnlyReopenCannotMutate: true,
    incompleteProfileConfigSkipProof: { absent: absent.state, zeroLength: incomplete.state,
      malformedComplete: malformedComplete.state },
    configOnlySelection: { fixtures: ["regular", "empty", "absent", "oversize"],
      inboxAuthority: "deferred", postJoinInboxProof: false } })
} catch (error) {
  failure = error
  facts.failureContext = { operation: facts.lastOperation, relativePath: facts.lastRelativePath }
}
finally {
  try {
    assert.deepEqual(await imageSnapshot(producerPath), producerBefore)
    facts.producerImageBytesAndMetadataUnchanged = true
  } catch (error) { failure ??= error; facts.producerImageBytesAndMetadataUnchanged = false }
  const closeFailures: string[] = []
  for (const handle of handles.reverse()) {
    try { await handle.close() } catch { closeFailures.push('native_handle_close_failed') }
  }
  try { await broker.close() } catch { closeFailures.push('native_broker_close_failed') }
  facts.closeFailures = closeFailures
  facts.nativeBrokerEnded = broker.ended()
  facts.qualified = failure === undefined && closeFailures.length === 0 && broker.ended()
  console.log(JSON.stringify(facts))
  if (closeFailures.length && failure === undefined) failure = new Error('windows_owner_cleanup_unknown')
}
if (failure !== undefined) throw failure
