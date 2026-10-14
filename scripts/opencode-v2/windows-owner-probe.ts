import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsOwnerFilesystem.js'
import { executionRecord } from '../../src/services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import { prepareWindowsPrivateDirectories } from '../../src/services/opencode/profile/OpenCodePrivateDirectories.js'
import { runControlDirectory } from '../../src/services/opencode/bridge/OpenCodeV2RunControl.js'

// Actual native helper only. Supply a NEW TEST directory under the CI scratch
// root. Retain its fences/records after both success and failure; no adoption,
// deletion, native model, provider, credential or user-project effects.
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert.equal(process.versions.bun, '1.3.11')
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
const powershell = async (script: string, target: string): Promise<string> => {
  assert.ok(process.env.ProgramFiles && path.win32.isAbsolute(process.env.ProgramFiles))
  const powershellRoot = path.win32.join(process.env.ProgramFiles, 'PowerShell', '7')
  const child = Bun.spawn([path.win32.join(powershellRoot, 'pwsh.exe'), '-NoProfile', '-NonInteractive',
    '-Command', "$ErrorActionPreference='Stop';" + script], {
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      PSModulePath: path.win32.join(powershellRoot, 'Modules'), TEST_TARGET: target }, stdout: 'pipe', stderr: 'ignore',
  })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  assert.equal(code, 0, 'TEST_fixture_powershell_failed')
  return output.trim()
}
// Observe only this new synthetic tree: native VolumeSerial/FileID/SID,
// complete owner/DACL descriptors, names and file bytes. Discovery must preserve it.
const snapshot = async (root: string): Promise<unknown[]> => {
  const rows: unknown[] = []
  const descriptors: Array<{ path: string; sddl: string }> = JSON.parse(await powershell(`
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
  selection: 'v1' | 'unsupported' | 'missing' = 'v1', ownerRecord?: unknown) => {
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
    const {discoverOpenCodeV2Run}=await import(${JSON.stringify(import.meta.resolve('../../src/services/opencode/bridge/OpenCodeV2RunControl.ts'))});
    phase='native_discovery';
    if(expected==='v1')assert.equal(await discoverOpenCodeV2Run(root,'TEST-team',runId),null);
    if(expected==='owner')assert.deepEqual(await discoverOpenCodeV2Run(root,'TEST-team',runId),${JSON.stringify(ownerRecord ?? null)});
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
  await powershell(`$a=Get-Acl -LiteralPath $env:TEST_TARGET;
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
    await powershell(`$a=Get-Acl -LiteralPath $env:TEST_TARGET;
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
  // Metadata-only synthetic database; no SQL/provider/auth is opened by this probe.
  await writeOwnedFixture(ownedSelectedData, selectedDataDirectory, 'opencode.db', 'TEST-synthetic-database')
  const claudeRoot = path.win32.join(requestedRoot, "TEST-claude")
  retain(await filesystem.createDirectory(claudeRoot))
  retain(await filesystem.createDirectory(path.win32.join(claudeRoot, "teams")))
  retain(await filesystem.createDirectory(path.win32.join(claudeRoot, "teams", "TEST-team")))
  retain(await filesystem.createDirectory(path.win32.join(claudeRoot, "tasks")))
  retain(await filesystem.createDirectory(path.win32.join(claudeRoot, "tasks", "TEST-team")))
  const inboxes = path.win32.join(claudeRoot, "teams", "TEST-team", "inboxes")
  const ownedInbox = retain(await filesystem.createDirectory(inboxes))
  await writeOwnedFixture(ownedInbox, inboxes, "user.json", "[]")
  const selectedContent = JSON.stringify({ mcpServers: { "agent-teams": { type: "local",
    env: { AGENT_TEAMS_MCP_CLAUDE_DIR: claudeRoot } } } })
  await writeOwnedFixture(ownedSelectedConfig, selectedConfigDirectory, "opencode.json", selectedContent)
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
  const statusResponses = new Set<Promise<void>>()
  const statusFailures: unknown[] = []
  let statusRequests = 0
  const respondToStatus = (event: unknown) => {
    const work = (async () => {
      const envelope = executionRecord(event), payload = executionRecord(envelope.payload)
      assert.equal(payload.protocol, 1)
      assert.deepEqual(payload.binding, binding)
      assert.equal(executionRecord(payload.request).operation, 'status')
      statusRequests++
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
  } finally {
    broker.events.off('runControlRequest', respondToStatus)
    await Promise.all(statusResponses)
  }
  assert.deepEqual(statusFailures, [])
  assert.equal(statusRequests, 2)
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
