import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'

if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.bun !== '1.3.11') throw new Error('native Windows x64 Bun 1.3.11 required')
const native = await import('./opencode-v2-windows-native.ts')
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const child = process.argv[2] === 'child'
if (child) {
  const base = process.argv[3]!, pipeName = process.argv[4]!
  const attempts: Record<string, boolean | number | string> = {}
  let baseUrl = ''
  const deny = async (name: string, action: () => Promise<unknown>) => {
    try { await action(); attempts[name] = false } catch (error) { attempts[name] = (error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
  try {
  await writeFile(path.join(base, 'work', 'allowed.txt'), 'owned write')
  attempts.ownedWrite = true
  await deny('outsideApprovedReadDenied', () => readFile(path.join(base, 'private-canary.txt')))
  await deny('outsideApprovedWriteDenied', () => writeFile(path.join(base, 'private-canary.txt'), 'escape'))
  await deny('siblingListingDenied', () => readdir(path.join(base, 'private-sibling')))
  await deny('hostStateWriteDenied', () => writeFile(path.join(base, 'host-state', 'secret.txt'), 'escape'))
  await deny('protectedWriteDenied', () => writeFile(path.join(base, 'work', 'protected', 'owner.json'), 'escape'))
  await deny('protectedRenameDenied', () => rename(path.join(base, 'work', 'protected'), path.join(base, 'work', 'stolen')))
  await deny('protectedDeleteDenied', () => rm(path.join(base, 'work', 'protected'), { recursive: true }))
  attempts.protectedAclEscapeError = native.attemptWindowsAclEscape(path.join(base, 'work', 'protected'))
  attempts.readOnlyAclEscapeError = native.attemptWindowsAclEscape(path.join(base, 'readonly'))
  await deny('readOnlyWriteDenied', () => writeFile(path.join(base, 'readonly', 'immutable.txt'), 'escape'))
  try {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('native-http-ok') })
    baseUrl = `http://127.0.0.1:${server.port}`
  } catch (error) { attempts.serverStartupError = String(error) }
  try { attempts.selfHttp = await (await fetch(baseUrl, { signal: AbortSignal.timeout(3000) })).text() } catch (error) { attempts.selfHttp = String(error) }
  try { attempts.internet = (await fetch('https://example.com', { signal: AbortSignal.timeout(10000) })).status } catch (error) { attempts.internet = String(error) }
  try {
    const descendant = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env } })
    attempts.descendantPID = descendant.pid
  } catch (error) { attempts.descendantStartupError = String(error) }
  attempts.jobBreakawayError = native.attemptWindowsJobBreakaway(process.execPath)
  } catch (error) { attempts.childStartupError = String(error); console.error(JSON.stringify({ childStartupError: String(error) })) }
  // Named pipe carries the probe response without admin loopback exemptions.
  console.log(JSON.stringify({ pid: process.pid, baseUrl, attempts }))
  const pipe = createConnection(pipeName)
  pipe.once('connect', () => { pipe.write(JSON.stringify({ pid: process.pid, baseUrl, attempts }) + '\n') })
  pipe.once('error', error => { void writeFile(path.join(base, 'work', 'pipe-error.txt'), String(error)) })
  setInterval(() => {}, 1000)
} else {
  const root = path.join(process.env.RUNNER_TEMP ?? process.env.TEMP!, `TEST-opencode-v2-windows-${randomUUID()}`)
  const output = process.argv[2] ?? path.join(root, 'evidence.json')
  const profileName = `AgentTeams.Test.${randomUUID()}`
  let container: ReturnType<typeof native.createWindowsContainer> | undefined
  let pipe: ReturnType<typeof native.createWindowsPipe> | undefined
  let launch: ReturnType<typeof native.launchWindowsContainer> | undefined
  const ancestorJournal = path.join(root, 'ancestor-ace-journal.json')
  const runPowerShell = async (script: string) => {
    const command = Bun.spawn([path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'pwsh.exe'), '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, PSModulePath: path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'Modules'), TEST_CONTAINER_SID: container!.sid, TEST_ROOT: root, TEST_ANCESTOR_JOURNAL: ancestorJournal }, stdout: 'pipe', stderr: 'pipe' })
    // Drain both streams; neither can block a setup or cleanup operation.
    const [stderr, stdout, code] = await Promise.all([new Response(command.stderr).text(), new Response(command.stdout).text(), command.exited])
    if (code !== 0) throw new Error(`TEST ACL operation:${stderr}${stdout}`)
  }
  const evidence: Record<string, unknown> = { schema: 1, purpose: 'TEST-native-feasibility', repositorySHA: process.env.GITHUB_SHA ?? null,
    os: process.platform, arch: process.arch, bun: process.versions.bun, profileName, root }
  try {
    await mkdir(root, { recursive: true })
    for (const directory of ['work', 'work/protected', 'host-state', 'readonly', 'private-sibling']) await mkdir(path.join(root, directory), { recursive: true })
    await writeFile(path.join(root, 'private-canary.txt'), 'host-owned')
    await writeFile(path.join(root, 'private-sibling', 'secret.txt'), 'host-owned')
    await writeFile(ancestorJournal, '[]')
    await writeFile(path.join(root, 'host-state', 'secret.txt'), 'host-owned')
    await writeFile(path.join(root, 'work', 'protected', 'owner.json'), 'host-owned')
    await writeFile(path.join(root, 'readonly', 'immutable.txt'), 'host-owned')
    await cp(process.execPath, path.join(root, 'readonly', 'bun.exe'))
    await cp(import.meta.filename, path.join(root, 'readonly', 'opencode-v2-windows-boundary.ts'))
    await cp(path.join(import.meta.dir, 'opencode-v2-windows-native.ts'), path.join(root, 'readonly', 'opencode-v2-windows-native.ts'))
    container = native.createWindowsContainer(profileName)
    evidence.containerSid = container.sid
    const pipeName = `\\\\.\\pipe\\LOCAL\\agt-${randomUUID()}`
    pipe = native.createWindowsPipe(pipeName, container.sid)
    // Only TEST-owned paths are ACL modified. Modify omits FILE_DELETE_CHILD;
    // explicit protected denies prohibit its deletion through the writable parent.
    const aclScript = `
$ErrorActionPreference = 'Stop'
$sid = New-Object System.Security.Principal.SecurityIdentifier($env:TEST_CONTAINER_SID)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$none = [System.Security.AccessControl.PropagationFlags]::None
function Rule($target, $rights, $effect) {
  $acl = Get-Acl -LiteralPath $target
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, $inherit, $none, $effect)))
  Set-Acl -LiteralPath $target -AclObject $acl
}
Rule (Join-Path $env:TEST_ROOT 'work') ([System.Security.AccessControl.FileSystemRights]::Modify) ([System.Security.AccessControl.AccessControlType]::Allow)
Rule (Join-Path $env:TEST_ROOT 'readonly') ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute) ([System.Security.AccessControl.AccessControlType]::Allow)
Rule (Join-Path $env:TEST_ROOT 'work/protected') ([System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership') ([System.Security.AccessControl.AccessControlType]::Deny)
Rule (Join-Path $env:TEST_ROOT 'host-state') ([System.Security.AccessControl.FileSystemRights]::FullControl) ([System.Security.AccessControl.AccessControlType]::Deny)
& icacls.exe (Join-Path $env:TEST_ROOT 'work') /setintegritylevel '(OI)(CI)L' /T /Q
if ($LASTEXITCODE -ne 0) { throw 'TEST low integrity setup failed' }
# Bun1.3.11 resolver opens every ancestor directory with mask0x1200a9.
# Each ACE applies to this directory only, never files or subdirectories.
$added = [System.Collections.Generic.List[string]]::new()
$ancestor = $env:TEST_ROOT
while ($ancestor) {
  $acl = Get-Acl -LiteralPath $ancestor
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, [System.Security.AccessControl.InheritanceFlags]::None, $none, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  $added.Add($ancestor)
  ConvertTo-Json -InputObject $added.ToArray() -Compress | Set-Content -LiteralPath $env:TEST_ANCESTOR_JOURNAL -Encoding utf8NoBOM
  Set-Acl -LiteralPath $ancestor -AclObject $acl
  $parentInfo = [System.IO.DirectoryInfo]::new($ancestor).Parent
  $parent = if ($parentInfo) { $parentInfo.FullName } else { $null }
  if ($parent -eq $ancestor) { break }
  $ancestor = $parent
}
`;
    await runPowerShell(aclScript)
    evidence.ancestorDirectoryAccessMask = '0x1200a9'
    evidence.ancestorGrantCount = (JSON.parse(await readFile(ancestorJournal, 'utf8')) as unknown[]).length
    const executable = path.join(root, 'readonly', 'bun.exe'), childOutput = path.join(root, 'child-output.txt')
    const launchEnv = { SystemRoot: process.env.SystemRoot!, WINDIR: process.env.WINDIR!, PATH: `${path.dirname(executable)};${process.env.SystemRoot}\\System32`,
      // CreateProcess constructs the profile namespace from this system path.
      // Chromium's AppContainer launcher also retains LOCALAPPDATA explicitly.
      LOCALAPPDATA: process.env.LOCALAPPDATA!, USERPROFILE: path.join(root, 'work'), HOME: path.join(root, 'work'),
      TEMP: path.join(root, 'work'), TMP: path.join(root, 'work') }
    evidence.environmentPresence = Object.fromEntries(Object.entries(launchEnv).map(([key, value]) => [key, typeof value === 'string' && value.length > 0]))
    if (Object.values(launchEnv).some(value => typeof value !== 'string' || value.length === 0)) throw new Error('required native environment path missing')
    launch = native.launchWindowsContainer({ containerSid: container.address, executable,
      arguments: [path.join(root, 'readonly', 'opencode-v2-windows-boundary.ts'), 'child', root, pipeName], cwd: path.join(root, 'work'), outputPath: childOutput,
      env: launchEnv, onEnvironmentShape: shape => { evidence.environmentShape = shape } })
    evidence.pid = launch.pid; evidence.birthFiletime = launch.birthFiletime; evidence.assignedBeforeResume = true
    let bytes = ''
    const deadline = Date.now() + 25000
    while (!bytes.includes('\n') && !launch.exited() && Date.now() < deadline) { bytes += pipe.read(); await pause(20) }
    if (!bytes.includes('\n')) {
      evidence.childExitCode = launch.exitCode()
      evidence.childOutput = await readFile(childOutput, 'utf8').catch(() => null)
      evidence.pipeError = await readFile(path.join(root, 'work', 'pipe-error.txt'), 'utf8').catch(() => null)
      throw new Error('native Bun/IPC probe did not report')
    }
    const report = JSON.parse(bytes.split('\n')[0]!) as { pid: number; baseUrl: string; attempts: Record<string, unknown> }
    evidence.report = report
    if (report.pid !== launch.pid) throw new Error('native PID mismatch')
    try { evidence.parentHttp = await (await fetch(report.baseUrl, { signal: AbortSignal.timeout(3000) })).text() } catch (error) { evidence.parentHttp = String(error) }
    evidence.activeWithDescendant = launch.active()
    launch.terminate()
    const retiredDeadline = Date.now() + 5000
    while (launch.active() !== 0 && Date.now() < retiredDeadline) await pause(20)
    evidence.activeAfterTerminate = launch.active(); evidence.processExited = launch.exited()
    evidence.hostStateRetained = await readFile(path.join(root, 'host-state', 'secret.txt'), 'utf8') === 'host-owned'
    evidence.protectedRetained = await readFile(path.join(root, 'work', 'protected', 'owner.json'), 'utf8') === 'host-owned'
    evidence.readOnlyRetained = await readFile(path.join(root, 'readonly', 'immutable.txt'), 'utf8') === 'host-owned'
    const critical = ['ownedWrite', 'outsideApprovedReadDenied', 'outsideApprovedWriteDenied', 'siblingListingDenied', 'hostStateWriteDenied', 'protectedWriteDenied', 'protectedRenameDenied', 'protectedDeleteDenied', 'readOnlyWriteDenied']
    evidence.filesystemPassed = critical.every(key => report.attempts[key] === true) && report.attempts.protectedAclEscapeError === 5 && report.attempts.readOnlyAclEscapeError === 5 && evidence.hostStateRetained && evidence.protectedRetained && evidence.readOnlyRetained
    evidence.jobPassed = Number(evidence.activeWithDescendant) >= 2 && evidence.activeAfterTerminate === 0 && evidence.processExited && report.attempts.jobBreakawayError === 5
    evidence.dropInLoopbackPassed = evidence.parentHttp === 'native-http-ok'
    evidence.qualified = evidence.filesystemPassed && evidence.jobPassed && evidence.dropInLoopbackPassed
  } catch (error) { evidence.error = String(error); evidence.qualified = false }
  finally {
    const cleanupErrors: string[] = []
    if (launch) {
      try {
        launch.terminate()
        const deadline = Date.now() + 5000
        while (launch.active() !== 0 && Date.now() < deadline) await pause(20)
        evidence.cleanupActiveProcesses = launch.active(); evidence.cleanupProcessExited = launch.exited()
        if (evidence.cleanupActiveProcesses !== 0 || !evidence.cleanupProcessExited) throw new Error('TEST native retirement uncertain')
      } catch (error) { cleanupErrors.push(String(error)) }
    }
    let heldHandlesClosed = !launch
    try { launch?.close(); heldHandlesClosed = true; evidence.cleanupHeldHandlesClosed = true } catch (error) { cleanupErrors.push(String(error)) }
    for (const dispose of [() => pipe?.close()]) {
      try { dispose() } catch (error) { cleanupErrors.push(String(error)) }
    }
    if (container && heldHandlesClosed && (!launch || (evidence.cleanupActiveProcesses === 0 && evidence.cleanupProcessExited === true))) {
      try {
        await runPowerShell(`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.SecurityIdentifier]::new($env:TEST_CONTAINER_SID)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, [System.Security.AccessControl.InheritanceFlags]::None, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
if (Test-Path -LiteralPath $env:TEST_ANCESTOR_JOURNAL) {
  $paths = @(Get-Content -LiteralPath $env:TEST_ANCESTOR_JOURNAL -Raw | ConvertFrom-Json)
  foreach ($target in $paths) {
    $acl = Get-Acl -LiteralPath $target
    $acl.RemoveAccessRuleSpecific($rule)
    Set-Acl -LiteralPath $target -AclObject $acl
    $remaining = (Get-Acl -LiteralPath $target).Access | Where-Object { !$_.IsInherited -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $_.InheritanceFlags -eq [System.Security.AccessControl.InheritanceFlags]::None -and $_.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and [int]$_.FileSystemRights -eq 0x1200a9 }
    if ($remaining) { throw 'TEST ancestor ACE remained after removal' }
  }
}
`)
        evidence.ancestorOwnAcesRemoved = true
      } catch (error) { cleanupErrors.push(String(error)) }
    } else if (container) cleanupErrors.push('TEST ancestor grants retained: native retirement uncertain')
    try { container?.close() } catch (error) { cleanupErrors.push(String(error)) }
    if (cleanupErrors.length) { evidence.cleanupErrors = cleanupErrors; evidence.qualified = false }
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify(evidence, null, 2))
  }
  if (!evidence.qualified) process.exitCode = 2
}
