import { openCodeBunVersion } from '../../src/constants/openCodeBunVersion.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsOwnerFilesystem.js'

// Native mechanism checkpoint only: exact packaged helper, private owned TEST
// tree and builtin-only Bun child. No official server/model/full-team claim.
assert.equal(process.platform, 'win32')
assert.equal(process.versions.bun, openCodeBunVersion())
const root = process.argv[2], receiptPath = process.argv[3]
assert.ok(root && receiptPath && path.win32.isAbsolute(root) && path.win32.isAbsolute(receiptPath))
assert.match(path.win32.basename(root), /^TEST-windows-command-[a-zA-Z0-9-]+$/)
// Explicit measurement mode is confined to this exact disposable SDK checkout.
// Product retirement deadlines and the ordinary native probe remain unchanged.
const fullGraphRoot = process.argv[4]
if (fullGraphRoot) {
  assert.equal(path.win32.basename(fullGraphRoot), 'TEST-native-sdk')
  assert.equal(fullGraphRoot, await realpath(path.resolve(import.meta.dir, '../..')))
}
const fullGraphFile = fullGraphRoot && path.join(fullGraphRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server', 'index.js')
if (fullGraphFile) assert.ok((await realpath(fullGraphFile)).startsWith(fullGraphRoot! + path.sep))
const fullGraphReadHash = fullGraphFile && createHash('sha256').update(await readFile(fullGraphFile)).digest('hex')
let fullGraphAclBaseline: string | undefined
const sharedReadRoot = root + '-shared-readonly'
const sharedReadFile = path.join(sharedReadRoot, 'vendor-input.txt')
let sharedReadBaseline: string | undefined
const ancestorRoot = root + '-ancestor-metadata'
const ancestorSelected = path.join(ancestorRoot, 'selected')
const ancestorSibling = path.join(ancestorRoot, 'ungranted-sibling')
const ancestorSecret = path.join(ancestorSibling, 'secret.txt')
const sourceBoundaryRoot = root + '-source-boundary'
const sourceDirectory = path.join(sourceBoundaryRoot, 'src')
const sourceEntry = path.join(sourceDirectory, 'entry.ts')
const ancestorAclPaths = [ancestorRoot, ancestorSibling, ancestorSecret]
let ancestorAclBaseline: Record<string, unknown>[] | undefined
let ancestorControlObserved: number | undefined
const profileRoot = path.join(root, 'opencode', 'v2', 'profiles', 'TEST-prepared')
const databasePath = path.join(profileRoot, 'data', 'opencode', 'opencode.db')
const profileChildren = ['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata', 'config/opencode', 'data/opencode'].map(value => path.join(profileRoot, value))
const configContent = JSON.stringify({ 'TEST-only': 'config-read-é' }), authContent = JSON.stringify({ 'TEST-provider': { type: 'api', key: 'TEST-never-used' } }, null, 2)
const expectedPreparedHashes = { configSHA256: createHash('sha256').update(configContent).digest('hex'), authSHA256: createHash('sha256').update(authContent).digest('hex') }
const nonce = randomUUID(), leaseOwnerId = randomUUID()
const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
broker.events.on('error', () => {})
const filesystem = createWindowsOwnerFilesystem(value => broker.request(value.op, value))
const handles: WindowsOwnerDirectory[] = []
const facts: Record<string, unknown> = { schema: 1, qualified: false, fullTaskQualified: false, kind: 'native-command-mechanisms', nonce }
let failure: unknown, stage = 'setup', launched = false, retired = false, sid: string | undefined
const powershell = path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'pwsh.exe')
async function ps(script: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([powershell, '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PSModulePath: path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'Modules'), TEST_ROOT: root, TEST_NONCE: nonce, ...extra }, stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`windows_command_setup_failed:${code}:${err.slice(-2048)}`)
  return out.trim()
}
async function fullGraphAcls(): Promise<string> {
  // Exclude only the historical AUTO_INHERITED marker; all ACE bytes, owner,
  // group, protection and other descriptor controls must compare exactly.
  return ps(`$ErrorActionPreference='Stop';$rows=@(foreach($p in @($env:TEST_GRAPH_ROOT,$env:TEST_GRAPH_FILE)){
$acl=Get-Acl -LiteralPath $p;$raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Owner-bor [Security.AccessControl.AccessControlSections]::Group-bor [Security.AccessControl.AccessControlSections]::Access))
$aces=@(foreach($ace in $raw.DiscretionaryAcl){$bytes=[byte[]]::new($ace.BinaryLength);$ace.GetBinaryForm($bytes,0);[Convert]::ToBase64String($bytes)})
[ordered]@{owner=$raw.Owner.Value;group=$raw.Group.Value;control=([int]$raw.ControlFlags-band (-bnot 1024));aces=$aces}});[Console]::Write(($rows|ConvertTo-Json -Compress -Depth 4))`,
    { TEST_GRAPH_ROOT: fullGraphRoot!, TEST_GRAPH_FILE: fullGraphFile! })
}
function record(value: unknown): Record<string, unknown> { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown> }
const messages: Record<string, unknown>[] = []
broker.events.on('message', value => messages.push(record(value)))
let nativePeer: Record<string, unknown> | undefined
let originalMapping: Record<string, unknown> | undefined
let mainExited: Record<string, unknown> | undefined
broker.events.on('connected', value => { nativePeer = record(value) })
broker.events.on('mainExited', value => { mainExited = record(value) })
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
// Serialized after Bun removes TypeScript syntax. This actual AppContainer
// child reads only synthetic prepared files and emits digests, never auth bytes.
async function verifyPreparedProfileFiles(): Promise<void> {
  const { readFile, stat } = await import('node:fs/promises')
  const { Database } = await import('bun:sqlite')
  const { createHash } = await import('node:crypto')
  const path = await import('node:path')
  const root = process.env.TEST_PREPARED_PROFILE
  if (!root) throw new Error('TEST_profile_missing')
  const config = await readFile(path.join(root, 'config', 'opencode', 'opencode.json'))
  const auth = await readFile(path.join(root, 'data', 'opencode', 'auth.json'))
  const databasePath = path.join(root, 'data', 'opencode', 'opencode.db')
  const before = await stat(databasePath, { bigint: true })
  if (before.size !== 0n) throw new Error('TEST_database_not_empty')
  // Same constructor/options and WAL initialization as BOTH installed official
  // sqlite.bun layers. Only this TEST table is ours; no official schema is faked.
  const db = new Database(databasePath, { readwrite: true, create: true })
  try {
    db.run('PRAGMA journal_mode = WAL;')
    db.run('CREATE TABLE TEST_bootstrap (value TEXT NOT NULL)')
    db.run("INSERT INTO TEST_bootstrap VALUES ('TEST-initialized')")
    const row = db.query<{ value: string }, []>('SELECT value FROM TEST_bootstrap').get()
    if (row?.value !== 'TEST-initialized') throw new Error('TEST_database_bootstrap_failed')
  } finally { db.close() }
  const after = await stat(databasePath, { bigint: true })
  if (after.dev !== before.dev || after.ino !== before.ino || after.size <= 0n)
    throw new Error('TEST_database_identity_changed')
  await Bun.stdout.write(JSON.stringify({ databaseInitialized: true, databaseFilePreserved: true, configSHA256: createHash('sha256').update(config).digest('hex'),
    authSHA256: createHash('sha256').update(auth).digest('hex') }))
}
async function assertProfilePackageAces(expected: boolean): Promise<void> {
  assert.ok(sid)
  const paths = [profileRoot, ...profileChildren, path.join(profileRoot, 'config', 'opencode', 'opencode.json'),
    path.join(profileRoot, 'data', 'opencode', 'auth.json'), databasePath]
  const rows: unknown = JSON.parse(await ps(`
$ErrorActionPreference='Stop'
$paths=@($env:TEST_PROFILE_PATHS|ConvertFrom-Json)
$rows=@(foreach($p in $paths){$acl=Get-Acl -LiteralPath $p;$present=$false
foreach($rule in @($acl.Access)){if($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value-eq $env:TEST_SID){$present=$true}}
[ordered]@{path=$p;present=$present;protected=$acl.AreAccessRulesProtected}})
[Console]::Write((ConvertTo-Json -InputObject $rows -Compress))`, { TEST_SID: sid, TEST_PROFILE_PATHS: JSON.stringify(paths) }))
  assert.ok(Array.isArray(rows)); assert.equal(rows.length, paths.length)
  rows.forEach((value: unknown, index: number) => {
    const row = record(value)
    assert.equal(row.path, paths[index]); assert.equal(row.present, expected)
    assert.equal(row.protected, index === 0)
  })
}
async function readAncestorAcls(): Promise<Record<string, unknown>[]> {
  const rows: unknown = JSON.parse(await ps(`
$ErrorActionPreference='Stop'
$rows=@(foreach($p in @($env:TEST_ACL_PATHS|ConvertFrom-Json)){
$acl=Get-Acl -LiteralPath $p
$descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Owner-bor [Security.AccessControl.AccessControlSections]::Access))
$aces=@(foreach($ace in $descriptor.DiscretionaryAcl){
$bytes=[byte[]]::new($ace.BinaryLength);$ace.GetBinaryForm($bytes,0)
if($ace -isnot [Security.AccessControl.CommonAce]){throw 'TEST unexpected ACE type'}
[ordered]@{sid=$ace.SecurityIdentifier.Value;type=[int]$ace.AceType;flags=[int]$ace.AceFlags;mask=$ace.AccessMask;bytes=[Convert]::ToBase64String($bytes)}})
[ordered]@{path=$p;owner=$descriptor.Owner.Value;control=[int]$descriptor.ControlFlags;aces=$aces}})
[Console]::Write((ConvertTo-Json -InputObject $rows -Depth 5 -Compress))`, { TEST_ACL_PATHS: JSON.stringify(ancestorAclPaths) }))
  assert.ok(Array.isArray(rows)); assert.equal(rows.length, ancestorAclPaths.length)
  return rows.map((value: unknown, index: number) => { const row = record(value); assert.equal(row.path, ancestorAclPaths[index]); assert.ok(Array.isArray(row.aces)); return row })
}
async function assertAncestorAcls(granted: boolean): Promise<{ sha256: string; parentControl: number }> {
  assert.ok(sid && ancestorAclBaseline)
  const baseline = ancestorAclBaseline
  const rows = await readAncestorAcls()
  const baselineControl = Number(baseline[0].control), parentControl = Number(rows[0].control)
  const firstGrant = granted && ancestorControlObserved === undefined
  let expectedControl = ancestorControlObserved ?? baselineControl
  if (firstGrant) {
    // SetFileSecurityW may clear this historical marker on its own first
    // non-propagating write. Pin that actual result; never mask later changes.
    assert.ok(parentControl === baselineControl ||
      ((baselineControl & 0x404) === 0x404 && parentControl === (baselineControl & ~0x400)))
    expectedControl = parentControl
  }
  rows.forEach((row, index) => {
    const aces = (row.aces as unknown[]).map(record)
    const own = aces.filter(ace => ace.sid === sid)
    assert.equal(own.length, granted && index === 0 ? 1 : 0)
    if (own.length) {
      assert.equal(own[0].type, 0); assert.equal(own[0].flags, 0)
      assert.equal(own[0].mask, 0x1200a9) // FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, target only.
    }
    assert.deepEqual({ ...row, aces: aces.filter(ace => ace.sid !== sid) },
      index === 0 ? { ...baseline[index], control: expectedControl } : baseline[index])
  })
  if (firstGrant) ancestorControlObserved = parentControl
  return { sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), parentControl }
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
async function closeCommand(commandId: string, expected?: { pid: number; birthFiletime: string }) {
  const value = record(await broker.request('commandRetire', { commandId }))
  assert.equal(value.empty, true); assert.equal(value.activeProcesses, 0); assert.equal(value.heldProcessExited, true)
  if (expected) {
    // commandRetire retains its process HANDLE until commandClose. This makes
    // observation of a signaled but still-existing process object deterministic.
    const held = record(await broker.request('identity', { pid: expected.pid }))
    assert.equal(held.absent, undefined); assert.equal(held.exited, true)
    assert.equal(held.hostPID, expected.pid); assert.equal(held.nativePID, expected.pid)
    assert.deepEqual(held.birth, { format: 'windows-filetime', value: expected.birthFiletime, bootId: null })
    facts.retiredCommandIdentity = held
  }
  const closed = record(await broker.request('commandClose', { commandId })); assert.equal(closed.closed, true)
  activeCommands.delete(commandId); return value
}
const environment: Record<string, string> = {
  SystemRoot: process.env.SystemRoot!, WINDIR: process.env.WINDIR!, LOCALAPPDATA: root,
  TEST_SHARED_READ_FILE: sharedReadFile,
  TEST_ANCESTOR_ROOT: ancestorRoot, TEST_ANCESTOR_SELECTED: ancestorSelected,
  TEST_ANCESTOR_SIBLING: ancestorSibling, TEST_ANCESTOR_SECRET: ancestorSecret,
  PATH: `${root};${path.join(process.env.SystemRoot!, 'System32')}`, USERPROFILE: root, HOME: root, TEMP: root, TMP: root, PWD: root,
}
try {
  const parent = await filesystem.createDirectory(root); await parent.close()
  // Exact native profile hierarchy; only its ROOT receives a launch grant.
  for (const directory of [path.join(root, 'opencode'), path.join(root, 'opencode', 'v2'),
    path.join(root, 'opencode', 'v2', 'profiles'), profileRoot, ...profileChildren.slice(0, 8)]) {
    const prepared = await filesystem.prepareDirectory(directory, true); await prepared.close()
  }
  const configDirectory = await filesystem.createDirectory(path.join(profileRoot, 'config', 'opencode'))
  try { await configDirectory.writePreparedConfig(configContent, expectedPreparedHashes.configSHA256) }
  finally { await configDirectory.close() }
  const dataDirectory = await filesystem.createDirectory(path.join(profileRoot, 'data', 'opencode'))
  try {
    await dataDirectory.writePreparedAuth(authContent, expectedPreparedHashes.authSHA256)
    await dataDirectory.createPreparedDatabase()
    assert.equal((await readFile(databasePath)).length, 0)
    await assert.rejects(dataDirectory.createPreparedDatabase())
    assert.equal((await readFile(databasePath)).length, 0)
  }
  finally { await dataDirectory.close() }
  const beforeDatabaseAdmission = record(await broker.request('ownerValidateSelectedProfile', {
    root: profileRoot, databasePath, directories: profileChildren }))
  const beforeDatabaseIdentity = record(beforeDatabaseAdmission.databaseIdentity)
  environment.TEST_PREPARED_PROFILE = profileRoot
  await writeFile(path.join(root, 'prepared-read.ts'), `(${verifyPreparedProfileFiles.toString()})()`)
  const fencePath = path.join(root, '.native-owner')
  const fence = await filesystem.createDirectory(fencePath); handles.push(fence)
  await fence.writeExclusive('owner.json', { schema: 1, testOnly: true, nonce, leaseOwnerId })
  await copyFile(process.execPath, path.join(root, 'bun.exe'))
  // Fresh sibling outside EVERY writable root. The actual source boundary
  // must resolve aliases without reading package/config metadata above src.
  assert.ok(path.relative(root, sourceBoundaryRoot).startsWith('..' + path.sep))
  for (const directory of [sourceBoundaryRoot, sourceDirectory]) {
    const held = await filesystem.createDirectory(directory); await held.close()
  }
  for (const name of ['package.json', 'tsconfig.json']) {
    await writeFile(path.join(sourceBoundaryRoot, name), await readFile(path.resolve(import.meta.dir, '../../', name)))
    await writeFile(path.join(sourceDirectory, name), await readFile(path.resolve(import.meta.dir, '../../src', name)))
  }
  await writeFile(path.join(sourceDirectory, 'alias-proof.ts'), await readFile(path.resolve(import.meta.dir, '../../src/utils/uuid.ts')))
  await writeFile(sourceEntry, `
import { validateUuid } from 'src/alias-proof.js'
import { readFile, open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const denied=async(work:()=>Promise<unknown>)=>{try{await work()}catch(error){if(['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))return;throw error}throw Error('TEST_source_boundary_access_admitted')}
await denied(()=>readFile(fileURLToPath(new URL('../package.json',import.meta.url))))
await denied(()=>readFile(fileURLToPath(new URL('../tsconfig.json',import.meta.url))))
await denied(async()=>{const file=await open(fileURLToPath(new URL('alias-proof.ts',import.meta.url)),'r+');await file.close()})
const value='11111111-1111-4111-8111-111111111111'
if(validateUuid(value)!==value)throw Error('TEST_source_alias_import_failed')
await Bun.stdout.write('source-boundary-passed')
`)
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
  await writeFile(path.join(root, 'output.ts'), `const fs=await import('node:fs/promises');const file=process.env.TEST_SHARED_READ_FILE!;if(await fs.readFile(file,'utf8')!=='TEST-readonly-vendor')throw Error('TEST_shared_read_failed');let denied=false;try{await fs.writeFile(file,'TEST-must-not-write')}catch(error){denied=['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??'')}if(!denied)throw Error('TEST_shared_write_not_denied');await Bun.write('actual-command.txt','native-command-written');await Bun.stdout.write(new TextEncoder().encode('native-output-é'));await Bun.stderr.write('native-error-marker')`)
  await writeFile(path.join(root, 'echo.ts'), `for await(const bytes of Bun.stdin.stream())await Bun.stdout.write(bytes);await Bun.stderr.write('stdin-eof-observed')`)
  await writeFile(path.join(root, 'grandchild.ts'), `await Bun.write('grandchild-live.txt',String(process.pid));setInterval(()=>{},1000)`)
  await writeFile(path.join(root, 'cancel.ts'), `const child=Bun.spawn([process.execPath,'grandchild.ts'],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});await Bun.write('cancel-child.txt',String(child.pid));setInterval(()=>{},1000)`)
  stage = 'shared-readonly-setup'
  // A separate fresh TEST sibling is outside every writable launch root.
  // Its elevated installer owner and Users RX model ordinary installed code.
  sharedReadBaseline = await ps(`
$ErrorActionPreference='Stop'
$p=$env:TEST_SHARED_ROOT
if(Test-Path -LiteralPath $p){throw 'TEST shared root already exists'}
[IO.Directory]::CreateDirectory($p)|Out-Null
[IO.File]::WriteAllText((Join-Path $p 'vendor-input.txt'),'TEST-readonly-vendor',[Text.UTF8Encoding]::new($false))
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-0'),'FullControl','ContainerInherit,ObjectInherit','InheritOnly','Allow'))
Set-Acl -LiteralPath $p -AclObject $acl
$actual=Get-Acl -LiteralPath $p
if($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value-ne 'S-1-5-32-544'){throw 'TEST shared owner not measured'}
[Console]::Write($actual.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Owner-bor [Security.AccessControl.AccessControlSections]::Access))
`, { TEST_SHARED_ROOT: sharedReadRoot })
  const readSharedAcl = () => ps(`$ErrorActionPreference='Stop';[Console]::Write((Get-Acl -LiteralPath $env:TEST_SHARED_ROOT).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Owner-bor [Security.AccessControl.AccessControlSections]::Access))`, { TEST_SHARED_ROOT: sharedReadRoot })
  const restoreSharedFixture = () => ps(`$ErrorActionPreference='Stop';$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetSecurityDescriptorSddlForm($env:TEST_SHARED_BASELINE);Set-Acl -LiteralPath $env:TEST_SHARED_ROOT -AclObject $acl`, { TEST_SHARED_ROOT: sharedReadRoot, TEST_SHARED_BASELINE: sharedReadBaseline! })
  const refuseSharedFixture = async (writable = false) => {
    const denied = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
    denied.events.on('error', () => {})
    const before = await readSharedAcl()
    try {
      await assert.rejects(denied.request('launch', { executable: path.join(root, 'bun.exe'), entry: path.join(root, 'main.ts'), cwd: root, env: environment,
        writableRoots: writable ? [sharedReadRoot] : [root, profileRoot], readOnlyRoots: writable ? [] : [sharedReadRoot],
        protectedRoots: [], nonce: randomUUID(), leaseOwnerId: randomUUID() }),
        (error: unknown) => error instanceof Error &&
          /^(?:execution_owner_not_private|execution_containment_filesystem_denied)(?::[a-z_]+:\d+)?$/.test(error.message))
      assert.equal(await readSharedAcl(), before)
    } finally { await denied.close() }
  }
  stage = 'shared-readonly-private-refusal'
  await refuseSharedFixture(true) // Administrators ownership must NOT qualify a writable root.
  stage = 'shared-readonly-foreign-write-refusal'
  await ps(`$ErrorActionPreference='Stop';$acl=Get-Acl -LiteralPath $env:TEST_SHARED_ROOT;$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Write','ContainerInherit,ObjectInherit','None','Allow'));Set-Acl -LiteralPath $env:TEST_SHARED_ROOT -AclObject $acl`, { TEST_SHARED_ROOT: sharedReadRoot })
  try { await refuseSharedFixture() } finally { await restoreSharedFixture() }
  stage = 'shared-readonly-effective-creator-refusal'
  const creator = record(JSON.parse(await ps(`
$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:TEST_SHARED_ROOT
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-0'),'Write','None','None','Allow'))
Set-Acl -LiteralPath $env:TEST_SHARED_ROOT -AclObject $acl
# Inspect the installed raw DACL, not the requested .NET rule: Windows can
# substitute the actual owner for an effective CREATOR OWNER ACE.
$actual=Get-Acl -LiteralPath $env:TEST_SHARED_ROOT
$descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($actual.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))
$present=$false
foreach($ace in $descriptor.DiscretionaryAcl){
if($ace -is [Security.AccessControl.CommonAce] -and $ace.AceQualifier-eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
$ace.SecurityIdentifier.Value-eq 'S-1-3-0' -and ($ace.AceFlags-band [Security.AccessControl.AceFlags]::InheritOnly)-eq 0 -and
($ace.AccessMask-band 278)-ne 0){$present=$true}}
[Console]::Write((@{effectiveCreatorWritePresent=$present}|ConvertTo-Json -Compress))
`, { TEST_SHARED_ROOT: sharedReadRoot })))
  assert.equal(typeof creator.effectiveCreatorWritePresent, 'boolean')
  try {
    if (creator.effectiveCreatorWritePresent) await refuseSharedFixture()
  } finally { await restoreSharedFixture() }
  assert.equal(await readSharedAcl(), sharedReadBaseline)
  facts.sharedReadOnlyRefusals = { privateOwnershipPreserved: true, foreignWriteRejected: true,
    effectiveCreatorWritePresent: creator.effectiveCreatorWritePresent,
    effectiveCreatorWriteRejected: creator.effectiveCreatorWritePresent ? true : null, deniedAclUnchanged: true }
  stage = 'test-ancestor-fixture'
  // This fresh TEST parent is never a recursive launch root. Its existing
  // inheriting ACL lets the probe detect accidental grants to sibling children.
  await ps(`
$ErrorActionPreference='Stop'
$p=$env:TEST_ANCESTOR_ROOT
if(Test-Path -LiteralPath $p){throw 'TEST ancestor fixture already exists'}
[IO.Directory]::CreateDirectory($p)|Out-Null
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
$acl.SetAccessRuleProtection($true,$false)
foreach($identity in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($identity),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
Set-Acl -LiteralPath $p -AclObject $acl
[IO.Directory]::CreateDirectory($env:TEST_ANCESTOR_SIBLING)|Out-Null
[IO.File]::WriteAllText($env:TEST_ANCESTOR_SECRET,'TEST-ungranted-secret',[Text.UTF8Encoding]::new($false))
# Low integrity keeps the access-denial checks focused on the DACL boundary.
& icacls.exe $p /setintegritylevel '(OI)(CI)L' /T /Q | Out-Null
if($LASTEXITCODE-ne 0){throw 'TEST ancestor low label failed'}
`, { TEST_ANCESTOR_ROOT: ancestorRoot, TEST_ANCESTOR_SIBLING: ancestorSibling, TEST_ANCESTOR_SECRET: ancestorSecret })
  const selected = await filesystem.createDirectory(ancestorSelected); await selected.close()
  await writeFile(path.join(root, 'ancestor-boundary.ts'), `
const fs=await import('node:fs/promises'),path=await import('node:path')
const denied=async(action:()=>Promise<unknown>)=>{try{await action()}catch(error){if(['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))return;throw error}throw Error('TEST_ancestor_access_not_denied')}
await denied(()=>fs.readFile(process.env.TEST_ANCESTOR_SECRET!))
await denied(()=>fs.writeFile(path.join(process.env.TEST_ANCESTOR_ROOT!,'forbidden-write.txt'),'TEST-must-not-write'))
await denied(()=>fs.writeFile(path.join(process.env.TEST_ANCESTOR_SIBLING!,'forbidden-write.txt'),'TEST-must-not-write'))
await fs.writeFile(path.join(process.env.TEST_ANCESTOR_SELECTED!,'granted-write.txt'),'TEST-selected-write')
await Bun.stdout.write('ancestor-boundary-passed')
`)
  stage = 'test-sid-derivation'
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
& icacls.exe $env:TEST_ROOT /setintegritylevel '(OI)(CI)L' /T /Q | Out-Null
if($LASTEXITCODE-ne 0){throw 'TEST low label failed'}
$sid
`)
  assert.match(sid, /^S-1-15-2-/)
  ancestorAclBaseline = await readAncestorAcls()
  const ancestorBefore = await assertAncestorAcls(false)
  facts.ancestorAclBeforeLaunchSHA256 = ancestorBefore.sha256
  stage = 'native-main-launch'; launched = true
  await fence.assertOwned()
  if (fullGraphRoot) fullGraphAclBaseline = await fullGraphAcls()
  const launchStarted = Date.now()
  const mapping = record(await broker.request('launch', { executable: path.join(root, 'bun.exe'), entry: path.join(root, 'main.ts'), cwd: root, env: environment, writableRoots: [root, profileRoot, ancestorSelected], readOnlyRoots: [sharedReadRoot, sourceDirectory, ...(fullGraphRoot ? [fullGraphRoot] : [])], protectedRoots: [fencePath], nonce, leaseOwnerId }, fullGraphRoot ? Date.now() + 150_000 : undefined))
  if (fullGraphRoot) facts.fullGraphLaunchElapsedMs = Date.now() - launchStarted
  assert.equal(mapping.containerSid, sid)
  const main = record(mapping.bun); originalMapping = mapping
  const connected = await until(() => nativePeer)
  assert.equal(connected.clientPID, main.nativePID)
  assert.deepEqual(connected, { ...mapping, clientPID: main.nativePID })
  await broker.request('send', { value: { type: 'prepare', nonce, leaseOwnerId, birth: main.birth, namespace: mapping.namespace } })
  const prepared = await until(() => messages.find(value => value.type === 'prepared'))
  assert.equal(prepared.pid, main.nativePID)
  assert.equal(prepared.nonce, nonce); assert.equal(prepared.leaseOwnerId, leaseOwnerId)
  assert.deepEqual(prepared.birth, main.birth); assert.equal(prepared.namespace, mapping.namespace)
  stage = 'native-source-boundary'
  const sourceCommand = await start(sourceEntry, 'ignore')
  const [sourceOutput, sourceError] = await Promise.all([output(sourceCommand.commandId, 'stdout'), output(sourceCommand.commandId, 'stderr')])
  assert.equal(sourceOutput.toString(), 'source-boundary-passed')
  const sourceStatus = record(await broker.request('commandStatus', { commandId: sourceCommand.commandId }))
  assert.equal(sourceStatus.running, false); assert.equal(sourceStatus.exitCode, 0)
  assert.equal(sourceStatus.outputLimitExceeded, false); assert.equal(sourceStatus.activeProcesses, 0)
  await closeCommand(sourceCommand.commandId)
  facts.sourceBoundary = { actualPinnedBun: true, actualSourceAliasModuleImported: true,
    parentPackageReadDenied: true, parentTsconfigReadDenied: true, sourceWriteDenied: true,
    sourceOutsideWritableRoots: true, exitCode: sourceStatus.exitCode,
    stderrBytes: sourceError.length, stderrSha256: createHash('sha256').update(sourceError).digest('hex') }
  if (fullGraphFile) {
    stage = 'native-full-graph-read'
    await writeFile(path.join(root, 'full-graph-read.ts'), `const fs=await import('node:fs/promises');const crypto=await import('node:crypto');const file=${JSON.stringify(fullGraphFile)};const bytes=await fs.readFile(file);let denied=false;try{const writer=await fs.open(file,'r+');await writer.close()}catch(error){denied=['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??'')}if(!denied)throw Error('TEST_full_graph_write_admitted');await Bun.stdout.write(crypto.createHash('sha256').update(bytes).digest('hex'))`)
    const read = await start(path.join(root, 'full-graph-read.ts'), 'ignore')
    const [bytes, errors] = await Promise.all([output(read.commandId, 'stdout'), output(read.commandId, 'stderr')])
    assert.equal(bytes.toString(), fullGraphReadHash); assert.equal(errors.length, 0)
    await closeCommand(read.commandId)
    facts.fullGraphReadPassed = true; facts.fullGraphWriteDenied = true
  }
  stage = 'native-ancestor-boundary'
  const ancestorDuring = await assertAncestorAcls(true)
  facts.ancestorAclDuringLaunchSHA256 = ancestorDuring.sha256
  facts.ancestorMetadataControl = { before: ancestorBefore.parentControl, observed: ancestorDuring.parentControl,
    ownWriteClearedAutoInherited: ancestorBefore.parentControl !== ancestorDuring.parentControl }
  const boundary = await start(path.join(root, 'ancestor-boundary.ts'), 'ignore')
  const [boundaryOutput, boundaryError] = await Promise.all([output(boundary.commandId, 'stdout'), output(boundary.commandId, 'stderr')])
  assert.equal(boundaryOutput.toString(), 'ancestor-boundary-passed'); assert.equal(boundaryError.length, 0)
  assert.equal(await readFile(path.join(ancestorSelected, 'granted-write.txt'), 'utf8'), 'TEST-selected-write')
  assert.equal(await readFile(ancestorSecret, 'utf8'), 'TEST-ungranted-secret')
  await closeCommand(boundary.commandId)
  facts.ancestorMetadata = { originalMainLaunchedWithoutTestAncestorGrants: true, targetOnlyReadExecuteAce: true,
    foreignAcesAndOwnerPreserved: true, siblingAclsUnchanged: true, siblingReadDenied: true,
    ancestorAndSiblingWriteDenied: true, selectedWritePassed: true }
  stage = 'native-prepared-profile-read'
  await assertProfilePackageAces(true)
  const preparedRead = await start(path.join(root, 'prepared-read.ts'), 'ignore')
  const [preparedOutput, preparedError] = await Promise.all([output(preparedRead.commandId, 'stdout'), output(preparedRead.commandId, 'stderr')])
  assert.equal(preparedError.length, 0)
  assert.deepEqual(JSON.parse(preparedOutput.toString('utf8')), { ...expectedPreparedHashes, databaseInitialized: true, databaseFilePreserved: true })
  const afterDatabaseAdmission = record(await broker.request('ownerValidateSelectedProfile', {
    root: profileRoot, databasePath, directories: profileChildren }))
  assert.deepEqual(afterDatabaseAdmission.databaseIdentity, beforeDatabaseIdentity)
  facts.preparedDatabaseBootstrapFileIdentityPreserved = true
  await closeCommand(preparedRead.commandId)
  facts.preparedProfileRootOnlyGrantReadHashes = expectedPreparedHashes
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
  assert.equal(descendantBirth.hostPID, descendantPID); assert.equal(descendantBirth.nativePID, descendantPID)
  assert.equal(descendantBirth.exited, false); assert.equal(descendantBirth.executablePath, path.join(root, 'bun.exe'))
  facts.cancelCommand = cancellation; facts.descendant = descendantBirth; facts.activeBeforeCancel = live.activeProcesses
  await closeCommand(cancellation.commandId, cancellation)
  const after = record(await broker.request('identity', { pid: descendantPID }))
  if (after.absent !== true) {
    assert.equal(after.exited, true)
    assert.equal(after.hostPID, descendantPID); assert.equal(after.nativePID, descendantPID)
    assert.deepEqual(after.birth, descendantBirth.birth)
  }
  facts.descendantAfterCancel = after
  assert.equal(await readFile(sharedReadFile, 'utf8'), 'TEST-readonly-vendor')
  facts.sharedReadOnlyReadPassed = true; facts.sharedReadOnlyWriteDenied = true
  facts.fileOutputPassed = true; facts.stdinEchoEofPassed = true; facts.descendantCancelPassed = true
  assert.equal((await assertAncestorAcls(true)).sha256, facts.ancestorAclDuringLaunchSHA256)
} catch (error) { failure = error }
finally {
  facts.failedStage = failure ? stage : undefined
  const cleanupErrors: string[] = []
  if (launched) {
    let retirementPhase = 'retire_rpc'
    const retirementFacts: Record<string, unknown> = {}
    try {
      const retirementStarted = Date.now()
      const receipt = record(await broker.request('retire', {}, fullGraphRoot ? Date.now() + 150_000 : undefined))
      if (fullGraphRoot) facts.fullGraphRetirementElapsedMs = Date.now() - retirementStarted
      retirementPhase = 'retire_receipt'
      for (const key of ['empty', 'activeProcesses', 'heldProcessExited', 'ownAcesRemoved']) {
        if (typeof receipt[key] === 'boolean' || typeof receipt[key] === 'number') retirementFacts[key] = receipt[key]
      }
      retirementFacts.receiptMappingMatches = isDeepStrictEqual(receipt.mapping, originalMapping)
      assert.equal(receipt.empty, true); assert.equal(receipt.activeProcesses, 0); assert.equal(receipt.heldProcessExited, true); assert.equal(receipt.ownAcesRemoved, true)
      assert.ok(originalMapping); assert.deepEqual(receipt.mapping, originalMapping)
      retirementPhase = 'main_exit_event'
      assert.ok(mainExited)
      retirementPhase = 'main_exit_proof'
      retirementFacts.mainExitHeldProcessExited = mainExited.heldProcessExited === true
      retirementFacts.mainExitMappingMatches = isDeepStrictEqual(mainExited.mapping, originalMapping)
      assert.equal(mainExited.heldProcessExited, true); assert.deepEqual(mainExited.mapping, originalMapping)
      facts.retirement = receipt; facts.originalMainRetirement = mainExited; retired = true
      // Observe removal only after the existing held-process/empty-job proof.
      // The test never grants or removes any package SID ACE on ancestors.
      retirementPhase = 'ancestor_aces_removed'
      const ancestorAfter = await assertAncestorAcls(false)
      facts.ancestorAclAfterRetirementSHA256 = ancestorAfter.sha256
      facts.ancestorMetadataControlAfterRetirement = ancestorAfter.parentControl
      facts.ancestorOwnAcesRemoved = true
      facts.ancestorOwnerForeignAndChildAclsPreserved = true
      retirementPhase = 'prepared_profile_aces_removed'
      await assertProfilePackageAces(false)
      facts.preparedProfileOwnAcesRemoved = true
      retirementPhase = 'shared_readonly_aces_removed'
      assert.ok(sharedReadBaseline)
      const after = await ps(`$ErrorActionPreference='Stop';[Console]::Write((Get-Acl -LiteralPath $env:TEST_SHARED_ROOT).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Owner-bor [Security.AccessControl.AccessControlSections]::Access))`, { TEST_SHARED_ROOT: sharedReadRoot })
      assert.equal(after, sharedReadBaseline)
      assert.equal(await readFile(sharedReadFile, 'utf8'), 'TEST-readonly-vendor')
      facts.sharedReadOnlyOwnerAndAclPreserved = true
      facts.sharedReadOnlyAclSHA256 = createHash('sha256').update(after).digest('hex')
      if (fullGraphRoot) {
        assert.equal(await fullGraphAcls(), fullGraphAclBaseline)
        facts.fullGraphForeignAcesOwnerGroupAndProtectionPreserved = true
        facts.fullGraphAclSHA256 = createHash('sha256').update(fullGraphAclBaseline!).digest('hex')
      }
    } catch (error) {
      const code = error instanceof Error && /^[a-z_]{1,96}(?::[a-z_]{1,64}:\d{1,10})?$/.test(error.message)
        ? error.message : error instanceof Error && error.name === 'AssertionError' ? 'retirement_assertion_failed' : 'retirement_unknown'
      facts.retirementFailure = { phase: retirementPhase, code, ...retirementFacts }
      cleanupErrors.push('native_scope_retirement_unknown')
    }
  }
  for (const handle of handles.reverse()) try { await handle.close() } catch { cleanupErrors.push('native_owner_handle_close_unknown') }
  try { await broker.close() } catch { cleanupErrors.push('native_broker_close_unknown') }
  facts.nativeBrokerEnded = broker.ended(); facts.cleanupErrors = cleanupErrors
  facts.qualified = failure === undefined && cleanupErrors.length === 0 && broker.ended() && retired
  await writeFile(receiptPath, JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify(facts))
  if (!failure && cleanupErrors.length) failure = new Error('windows_command_cleanup_unknown')
}
if (failure) throw failure
