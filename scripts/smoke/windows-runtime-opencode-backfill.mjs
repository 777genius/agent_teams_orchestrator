#!/usr/bin/env node
// Run with Node 24 against an already compiled Windows runtime; never compiles or installs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureSource = fileURLToPath(new URL('./windows-runtime-opencode-fixture.cjs', import.meta.url));
const taskId = 'task-1';
const teamName = 'backfill-fixture';
const memberName = 'bob';
const laneId = 'secondary:opencode:bob';
const sessionId = 'session-bob';
const content = 'Fixture only: spaces, "quotes", C:\\fake\\path, Привет 世界\n';
const backfillCases = [
  ['ascii', 'direct'], ['with spaces', 'direct'], ['Юникод 世界', 'direct'],
  ['Юникод 世界 cmd', 'app-exe-fallback'],
];

export function fixtureScriptPaths(root) {
  return ['', ...backfillCases.map(([shape]) => shape)]
    .map(directory => path.resolve(root, directory, 'fake-opencode.cjs'));
}

export function trustedSearchPath(platform = process.platform, nodePath = process.execPath, systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows') {
  const paths = platform === 'win32' ? path.win32 : path;
  return [paths.dirname(nodePath), ...(platform === 'win32'
    ? [paths.join(systemRoot, 'System32'), paths.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')]
    : ['/usr/bin', '/bin'])].join(platform === 'win32' ? ';' : ':');
}

export function stageRuntimeDelivery(runtimeBinary, binaryDir) {
  const sourceDir = path.dirname(runtimeBinary);
  const hasBun = existsSync(path.join(sourceDir, 'bun'));
  const hasGraph = existsSync(path.join(sourceDir, 'local-cli'));
  assert.equal(hasBun, hasGraph, 'Packaged runtime relocation requires both bun and local-cli');
  const binary = path.join(binaryDir, 'runtime.exe');
  copyFileSync(runtimeBinary, binary);
  // Release front doors verify and execute these physical siblings after relocation.
  // Standalone compile fixtures have neither and retain their original coverage.
  for (const directory of ['bun', 'local-cli', 'cursor-managed']) {
    const source = path.join(sourceDir, directory);
    if (existsSync(source)) cpSync(source, path.join(binaryDir, directory), { recursive: true });
  }
  return binary;
}

export function sandboxEnvironment(root, fakeBinary) {
  // Allowlist platform plumbing. Do not inherit credentials, runtime selection,
  // shell startup hooks, provider config paths, or actual project/home pointers.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(systemroot|windir|comspec|pathext|systemdrive)$/i.test(key)) env[key] = value;
  }
  // The fake provider uses this Node; Windows process inspection needs system tools.
  env.PATH = trustedSearchPath();
  const dirs = {
    HOME: 'home', USERPROFILE: 'home', APPDATA: 'AppData/Roaming', LOCALAPPDATA: 'AppData/Local',
    TMP: 'temp', TEMP: 'temp', TMPDIR: 'temp',
    XDG_CONFIG_HOME: 'home/.config', XDG_DATA_HOME: 'home/.local/share',
    XDG_CACHE_HOME: 'home/.cache', XDG_STATE_HOME: 'home/.local/state',
    CLAUDE_CONFIG_DIR: 'claude-config', CLAUDE_MULTIMODEL_DATA_HOME: 'data',
    CLAUDE_MULTIMODEL_CACHE_HOME: 'cache',
  };
  for (const [key, relative] of Object.entries(dirs)) {
    env[key] = path.join(root, relative);
    mkdirSync(env[key], { recursive: true });
  }
  const homeRoot = path.parse(env.HOME).root;
  env.HOMEDRIVE = homeRoot.replace(/[\\/]$/, '');
  env.HOMEPATH = env.HOME.slice(env.HOMEDRIVE.length);
  return Object.assign(env, {
    CI: 'true', NODE_ENV: 'production',
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: fakeBinary,
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    OPENCODE_SNAPSHOT_PROOF_UPGRADE: 'off',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'),
  });
}

export function createBackfillFixture(env, workspaceRoot, projectDir) {
  const taskRefs = [{ taskId, displayId: 'abc12345', teamName }];
  const delivery = {
    schemaVersion: 1, kind: 'opencode-delivery-context', teamName, memberName, laneId,
    inboundMessageId: 'user-1', taskRefs,
  };
  const prompt = `<opencode_app_message_delivery>\n<opencode_delivery_context>${JSON.stringify(delivery)}</opencode_delivery_context>\n</opencode_app_message_delivery>\n\n<opencode_inbound_app_message>\n${content}</opencode_inbound_app_message>`;
  const dbPath = path.join(env.CLAUDE_MULTIMODEL_DATA_HOME, 'opencode/profiles/fixture-profile/data/opencode/opencode.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, vcs TEXT);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO project VALUES (?, ?, ?)').run('project-fixture', workspaceRoot, 'git');
    db.prepare('INSERT INTO session VALUES (?, ?, ?)').run(sessionId, 'project-fixture', workspaceRoot);
    const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, NULL, ?)');
    message.run('user-1', sessionId, 900, JSON.stringify({ id: 'user-1' }));
    message.run('assistant-1', sessionId, 1000, JSON.stringify({ id: 'assistant-1', parentID: 'user-1' }));
    const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, NULL, ?)');
    part.run('user-text-1', 'user-1', sessionId, 900, JSON.stringify({ type: 'text', text: prompt }));
    part.run('write-1', 'assistant-1', sessionId, 1000, JSON.stringify({
      type: 'tool', tool: 'write', callID: 'write-call-1',
      state: { status: 'completed', input: { filePath: path.join(workspaceRoot, 'fixture.txt'), content },
        metadata: { exists: false, truncated: false }, time: { end: 1000 } },
    }));
  } finally { db.close(); }
  const record = {
    teamId: teamName, laneId, memberName, providerId: 'opencode', selectedModel: 'opencode/big-pickle',
    projectPath: workspaceRoot, profileRootKey: 'fixture-profile', hostKey: 'fixture-host',
    resolvedBehaviorFingerprint: 'fixture-behavior', opencodeSessionId: sessionId,
    lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: 'idle',
    sourceAuthFingerprint: null, managedAuthFingerprint: null, projectBehaviorFingerprint: 'fixture-behavior',
    staleReason: null, createdAt: '2026-04-26T10:00:00.000Z', updatedAt: '2026-04-26T10:00:00.000Z',
  };
  writeFileSync(path.join(env.CLAUDE_MULTIMODEL_DATA_HOME, 'opencode/session-store.json'),
    JSON.stringify({ schemaVersion: 1, records: { [`${teamName}::${laneId}::${memberName}`]: record } }));
  const contextDir = mkdtempSync(path.join(env.TEMP, 'claude-team-opencode-ledger-context-'));
  const deliveryContextPath = path.join(contextDir, 'delivery-context.json');
  const context = JSON.stringify({ schemaVersion: 1, teamName, taskId, records: [{
    memberName, laneId, runtimeSessionId: sessionId, inboxMessageId: 'user-1',
    deliveredUserMessageId: null, observedAssistantMessageId: null,
    prePromptCursor: null, postPromptCursor: null, taskRefs,
  }] });
  writeFileSync(deliveryContextPath, context, { mode: 0o600 });
  return {
    body: { teamId: teamName, teamName, taskId, taskDisplayId: 'abc12345', memberName, laneId,
      projectDir, workspaceRoot, deliveryContextPath, deliveryContextHash: sha256(context),
      attributionMode: 'strict-delivery' },
    dbPath,
  };
}

export function assertBackfillEnvelope(payload, envelope, outcome, importedEvents) {
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.requestId, envelope.requestId);
  assert.equal(payload.command, envelope.command);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.data?.schemaVersion, 1);
  assert.equal(payload.data?.providerId, 'opencode');
  assert.equal(payload.data?.opencodeTaskLedgerEvidenceContractVersion, 1);
  for (const key of ['teamName', 'taskId', 'projectDir', 'workspaceRoot']) {
    assert.equal(payload.data[key], envelope.body[key], key);
  }
  assert.equal(payload.data.dryRun, false);
  assert.equal(payload.data.attributionMode, envelope.body.attributionMode);
  assert.equal(payload.data.outcome, outcome, JSON.stringify(payload.data));
  assert.equal(payload.data.importedEvents, importedEvents);
  assert.equal(payload.data.scannedSessions, outcome === 'no-history' ? 0 : 1);
  assert.equal(payload.data.candidateEvents, outcome === 'no-history' ? 0 : 1);
}

export function assertImportedLedger(projectDir) {
  const ledgerDir = path.join(projectDir, '.board-task-changes');
  const eventsPath = path.join(ledgerDir, 'events', `${taskId}.jsonl`);
  const raw = readFileSync(eventsPath, 'utf8');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 1, 'exactly one imported fixture event, including after replay');
  const event = events[0];
  for (const [key, value] of Object.entries({ taskId, memberName, relativePath: 'fixture.txt',
    sourceRuntime: 'opencode', sourceSessionId: sessionId, sourcePartId: 'write-1',
    sourceMessageId: 'assistant-1', source: 'opencode_toolpart_write', operation: 'create' })) {
    assert.equal(event[key], value, `ledger ${key}`);
  }
  assert.equal(event.after?.sha256, sha256(content));
  assert.equal(readFileSync(path.join(ledgerDir, 'blobs', event.after.blobRef), 'utf8'), content);
  return { events, journalSha256: sha256(raw) };
}

// Frozen .exe-only projection of app childProcess.ts at e413d5420625a21f3c78f883e1b45f414f474f61:
// quoteWindowsCmdArg, escapeWindowsCmdFallbackArg, execShellAsync. This tests the
// emitted transport, not the app's runner selection/integration. No batch target.
export function appExeFallback(binary, args, env) {
  const quoteChunk = chunk => `"${chunk.replace(/(\\*)"/g, (_match, slashes) => `${slashes}${slashes}\\"`).replace(/(\\+)$/g, '$1$1')}"`;
  const command = /[^A-Za-z0-9_\-/.]/.test(binary) ? binary.split('%').map(quoteChunk).join('^%') : binary;
  const escapedArgs = args.map(arg => {
    const quoted = `"${arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/g, '$1$1')}"`;
    return quoted.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  });
  const rawCommand = `"${[command, ...escapedArgs].join(' ')}"`;
  return { command: path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/v:off', '/c', rawCommand], windowsVerbatimArguments: true };
}

// Parse just the first two Windows arguments. Quoted arguments must close before
// the boundary; unquoted arguments cannot contain whitespace or quotes. Compare
// the entire captured script path, never a prefix. Shared with the regression.
export const windowsNodeScriptPattern = String.raw`^(?:"(?<quotedExe>[^"]+)"|(?<bareExe>[^\s"]+))[ \t]+(?:"(?<quotedScript>[^"]+)"|(?<bareScript>[^\s"]+))(?:[ \t]|$)`;

// Only stop executables copied into this unique sandbox, or Node running an
// exact fixture script within it. Never kill by PID alone or by image name.
export function buildWindowsTeardownCommand(root, diagnosticPids = []) {
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  // PIDs select bounded diagnostics only; they never confer ownership.
  const candidates = diagnosticPids.filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff).slice(0, 8);
  return String.raw`
[Console]::Error.WriteLine('teardown: started')
$ErrorActionPreference = 'Stop'
# Direct stderr markers need no modules and survive a later import/query timeout.
[Console]::Error.WriteLine('teardown: before import Microsoft.PowerShell.Management')
Import-Module Microsoft.PowerShell.Management -ErrorAction Stop
[Console]::Error.WriteLine('teardown: after import Microsoft.PowerShell.Management')
[Console]::Error.WriteLine('teardown: before load System.Management')
[void][System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
[Console]::Error.WriteLine('teardown: after load System.Management')
[Console]::Error.WriteLine('teardown: before import Microsoft.PowerShell.Utility')
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
[Console]::Error.WriteLine('teardown: after import Microsoft.PowerShell.Utility')
$rootPath = ${literal(path.resolve(root) + path.sep)}
$nodePath = ${literal(process.execPath)}
$nodeScriptPattern = ${literal(windowsNodeScriptPattern)}
$diagnosticPids = @(${candidates.join(', ')})
$fixtureScriptCandidates = @(${fixtureScriptPaths(root).map(literal).join(', ')})
function Get-OwnershipPath([string]$value) {
  # Windows PowerShell/.NET Framework GetFullPath expands existing 8.3 names.
  # Reject relative paths: the inspecting shell is not the target process cwd.
  if ($value -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])') { return $null }
  try { return [IO.Path]::GetFullPath($value) } catch { return $null }
}
$rootPath = Get-OwnershipPath $rootPath
$nodePath = Get-OwnershipPath $nodePath
if (-not $rootPath -or -not $nodePath) { throw 'Fixture ownership paths must be absolute' }
[Console]::Error.WriteLine('teardown: before script enumeration')
# The fixture creates only these exact script locations. Never walk the copied
# portable dependency graphs; they cannot introduce cleanup ownership.
$scripts = @(foreach ($candidate in $fixtureScriptCandidates) {
  $script = Get-OwnershipPath $candidate
  if (-not $script -or -not $script.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture script path escaped root' }
  if (Test-Path -LiteralPath $script -PathType Leaf) { $script }
})
[Console]::Error.WriteLine('teardown: after script enumeration count=' + $scripts.Count)
function Is-Owned($entry) {
  $executablePath = Get-OwnershipPath $entry.ExecutablePath
  if (-not $executablePath) { return $false }
  if ($executablePath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  if ($executablePath -ieq $nodePath) {
    if ($entry.CommandLine -match $nodeScriptPattern) {
      $commandExe = if ($Matches['quotedExe']) { $Matches['quotedExe'] } else { $Matches['bareExe'] }
      $commandScript = if ($Matches['quotedScript']) { $Matches['quotedScript'] } else { $Matches['bareScript'] }
      if (@('node', 'node.exe') -icontains $commandExe -or (Get-OwnershipPath $commandExe) -ieq $nodePath) {
        $scriptPath = Get-OwnershipPath $commandScript
        return ($scriptPath -and $scripts -icontains $scriptPath)
      }
    }
  }
  return $false
}
# Query local WMI under this same identity, without loading CimCmdlets.
# Read the actual ManagementBaseObject properties, independent of PowerShell's
# WMI adapter, and copy all four fields before releasing the WMI resources.
function Read-ProcessEntries([string]$filter = '') {
  $searcher = [System.Management.ManagementObjectSearcher]::new('SELECT ProcessId, ExecutablePath, CommandLine, CreationDate FROM Win32_Process' + $filter)
  $results = $null
  try {
    $results = $searcher.Get()
    foreach ($row in $results) {
      try {
        $creationDate = $row.GetPropertyValue('CreationDate')
        if ($diagnosticPids -contains $row.GetPropertyValue('ProcessId')) {
          $projection = [ordered]@{ pid = $row.GetPropertyValue('ProcessId') }
          foreach ($name in @('ProcessId', 'ExecutablePath', 'CommandLine', 'CreationDate')) {
            $projection[$name + 'Present'] = $null -ne $row.GetPropertyValue($name)
            $projection[$name + 'AdapterEqual'] = $row.$name -ceq $row.GetPropertyValue($name)
          }
          [Console]::Error.WriteLine('teardown: fixture projection ' + (ConvertTo-Json -InputObject $projection -Compress))
        }
        [pscustomobject]@{
          ProcessId = $row.GetPropertyValue('ProcessId')
          ExecutablePath = $row.GetPropertyValue('ExecutablePath')
          CommandLine = $row.GetPropertyValue('CommandLine')
          CreationDate = if ($creationDate) { [System.Management.ManagementDateTimeConverter]::ToDateTime($creationDate) } else { $null }
        }
      } finally { $row.Dispose() }
    }
  } finally {
    if ($null -ne $results) { $results.Dispose() }
    $searcher.Dispose()
  }
}
$stopped = @()
[Console]::Error.WriteLine('teardown: before process enumeration')
$entries = @(Read-ProcessEntries)
[Console]::Error.WriteLine('teardown: after process enumeration count=' + $entries.Count)
foreach ($entry in $entries) {
  $owned = Is-Owned $entry
  if ($diagnosticPids -contains $entry.ProcessId) {
    # No host command lines, even for candidates. Only bounded parsed paths and
    # match results for the explicit fixture PIDs are emitted on stderr.
    $scriptArg = $null
    $argvMatched = $entry.CommandLine -match $nodeScriptPattern
    if ($argvMatched) { $scriptArg = if ($Matches['quotedScript']) { $Matches['quotedScript'] } else { $Matches['bareScript'] } }
    $diagnostic = [ordered]@{ pid = $entry.ProcessId; owned = $owned; argvMatched = $argvMatched }
    foreach ($pair in @(@('script', $scriptArg), @('scriptFullPath', (Get-OwnershipPath $scriptArg)), @('rootFullPath', $rootPath))) {
      $value = [string]$pair[1]
      $diagnostic[$pair[0]] = $value.Substring(0, [Math]::Min(512, $value.Length))
    }
    $diagnostic['nodePathMatches'] = (Get-OwnershipPath $entry.ExecutablePath) -ieq $nodePath
    [Console]::Error.WriteLine('teardown: fixture ownership ' + (ConvertTo-Json -InputObject $diagnostic -Compress))
  }
  if (-not $owned) { continue }
  [Console]::Error.WriteLine('teardown: before Get-Process pid=' + $entry.ProcessId)
  $target = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
  [Console]::Error.WriteLine('teardown: after Get-Process pid=' + $entry.ProcessId + ' found=' + [bool]$target)
  if (-not $target) { continue }
  try {
    # Hold the process handle before the second identity check, avoiding PID reuse.
    [Console]::Error.WriteLine('teardown: before hold handle pid=' + $entry.ProcessId)
    $heldHandle = $target.Handle
    [Console]::Error.WriteLine('teardown: after hold handle pid=' + $entry.ProcessId)
    [Console]::Error.WriteLine('teardown: before identity query pid=' + $entry.ProcessId)
    $current = Read-ProcessEntries (" WHERE ProcessId = " + $entry.ProcessId)
    [Console]::Error.WriteLine('teardown: after identity query pid=' + $entry.ProcessId + ' found=' + [bool]$current)
    if (-not $current) { continue }
    [Console]::Error.WriteLine('teardown: before identity validation pid=' + $entry.ProcessId)
    if ($null -eq $entry.CreationDate -or $current.CreationDate -ne $entry.CreationDate -or -not (Is-Owned $current)) { throw 'Owned process identity changed during cleanup' }
    [Console]::Error.WriteLine('teardown: after identity validation pid=' + $entry.ProcessId)
    $stopped += @{ pid = $entry.ProcessId; executable = $entry.ExecutablePath; commandLine = $entry.CommandLine; startedAt = $entry.CreationDate.ToUniversalTime().ToString('o') }
    [Console]::Error.WriteLine('teardown: before kill pid=' + $entry.ProcessId)
    $target.Kill()
    [Console]::Error.WriteLine('teardown: after kill pid=' + $entry.ProcessId)
    [Console]::Error.WriteLine('teardown: before wait for exit pid=' + $entry.ProcessId)
    if (-not $target.WaitForExit(5000)) { throw 'Owned process did not exit during cleanup' }
    [Console]::Error.WriteLine('teardown: after wait for exit pid=' + $entry.ProcessId)
  } finally {
    [Console]::Error.WriteLine('teardown: before dispose pid=' + $entry.ProcessId)
    $target.Dispose()
    [Console]::Error.WriteLine('teardown: after dispose pid=' + $entry.ProcessId)
  }
}
[Console]::Error.WriteLine('teardown: before JSON output')
ConvertTo-Json -InputObject $stopped -Depth 4 -Compress
[Console]::Error.WriteLine('teardown: after JSON output')
`;
}

export function teardownOwnedProcesses(root, report, env = sandboxEnvironment(root, path.join(root, 'opencode.cmd'))) {
  const command = buildWindowsTeardownCommand(root, (report.children || []).map(child => child.pid));
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
  const started = performance.now();
  const result = spawnSync('powershell.exe', argv, { env, cwd: root, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  report.teardown = { executable: 'powershell.exe', argv, pid: result.pid, status: result.status,
    elapsedMs: Math.round(performance.now() - started), timeoutMs: 30000, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message, errorCode: result.error?.code };
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Owned-process teardown failed: ${result.stderr}`);
}

export function finishSmokeCleanup(report, root, { teardown = teardownOwnedProcesses, remove = rmSync } = {}) {
  report.passed = false;
  try { teardown(root, report); }
  catch (error) { report.cleanupError = error.stack || String(error); }
  try { remove(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); }
  catch (error) {
    report.cleanupError = [report.cleanupError, error.stack || String(error)].filter(Boolean).join('\n');
    report.remainingRoot = root;
  }
  report.passed = !report.cleanupError && !report.error && report.cases.length > 0 && report.cases.every(item => item.passed);
}

export function runSmokeGroups(report, groups, flush) {
  report.passed = false;
  report.groups = {};
  flush();
  for (const [name, run] of Object.entries(groups)) {
    const group = report.groups[name] = { passed: false, cases: [] };
    flush();
    try { run(group, flush); }
    catch (error) { group.passed = false; group.error = error.stack || String(error); }
    flush();
  }
  report.passed = Object.values(report.groups).length > 0 && Object.values(report.groups).every(group => group.passed);
  flush();
  return report;
}

export function runBackfillSmoke(binaryInput, evidenceInput, { report: suppliedReport, flush: suppliedFlush } = {}) {
  assert.equal(process.platform, 'win32', 'Packaged Windows coverage requires actual Windows execution');
  const runtimeBinary = path.resolve(binaryInput);
  assert.equal(path.extname(runtimeBinary).toLowerCase(), '.exe');
  const evidencePath = path.resolve(evidenceInput || 'backfill-runtime-evidence.json');
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  // Failures are evidence too. All shapes run even when an earlier shape fails.
  const report = Object.assign(suppliedReport || {}, { schemaVersion: 1, parentPid: process.pid, platform: process.platform, arch: process.arch,
    nodeVersion: process.version, sourceCommit: process.env.BACKFILL_RUNTIME_SOURCE_COMMIT,
    buildBunVersion: process.env.BACKFILL_RUNTIME_BUN_VERSION, runtimeBinary, executableSha256: sha256(readFileSync(runtimeBinary)),
    cases: [], passed: false });
  const flush = suppliedFlush || (() => writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n'));
  flush();
  // The native API also expands Windows 8.3 names; the JS walk only resolves links.
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'backfill-exe-')));
  try {
    for (const [shape, transport] of backfillCases) {
      const item = { shape, transport, invocations: [], passed: false };
      report.cases.push(item);
      const caseRoot = path.join(root, shape);
      try {
        const binaryDir = path.join(caseRoot, 'bin');
        const projectPath = path.join(caseRoot, 'project');
        const projectDir = path.join(caseRoot, 'ledger-project');
        for (const dir of [binaryDir, projectPath, projectDir]) mkdirSync(dir, { recursive: true });
        const binary = path.join(binaryDir, 'runtime.exe');
        if (shape === 'ascii') assert.match(binary, /^[\x21-\x7e]+$/, 'ASCII case needs an ASCII temp root without spaces');
        stageRuntimeDelivery(runtimeBinary, binaryDir);
        item.executableSha256 = sha256(readFileSync(binary));
        assert.equal(item.executableSha256, report.executableSha256);
        copyFileSync(fixtureSource, path.join(caseRoot, 'fake-opencode.cjs'));
        const fakeBinary = path.join(caseRoot, 'opencode.cmd');
        writeFileSync(fakeBinary, `@echo off\r\n"${process.execPath}" "%~dp0fake-opencode.cjs" %*\r\n`);
        const env = sandboxEnvironment(caseRoot, fakeBinary);
        const invoke = (label, body, outcome, count) => {
          const input = path.join(env.TEMP, `${label}.input.json`);
          const output = path.join(env.TEMP, `${label}.output.json`);
          const envelope = { schemaVersion: 1, requestId: `backfill-${shape}-${label}`,
            command: label === 'control' ? 'opencode.commandStatus' : 'opencode.backfillTaskLedger', cwd: projectPath,
            startedAt: new Date().toISOString(), timeoutMs: 45000, body };
          writeFileSync(input, JSON.stringify(envelope), { mode: 0o600 });
          const args = ['runtime', 'opencode-command', '--json', '--input', input, '--output', output];
          const invocation = { label, executable: binary, argv: args, cwd: projectPath,
            transport, envelope, inputSha256: sha256(readFileSync(input)) };
          const launch = transport === 'direct' ? { command: binary, args, windowsVerbatimArguments: false }
            : appExeFallback(binary, args, env);
          invocation.launch = launch;
          item.invocations.push(invocation);
          flush();
          const result = spawnSync(launch.command, launch.args, { windowsVerbatimArguments: launch.windowsVerbatimArguments, cwd: projectPath, env, encoding: 'utf8',
            timeout: 60000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, shell: false });
          Object.assign(invocation, { pid: result.pid, status: result.status, signal: result.signal,
            stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
          if (existsSync(output)) invocation.output = readFileSync(output, 'utf8');
          flush();
          if (result.error) throw result.error;
          assert.equal(result.status, 0, JSON.stringify(invocation));
          assert.doesNotMatch(result.stderr, /too many arguments/i);
          const payload = JSON.parse(invocation.output);
          if (label === 'control') {
            assert.equal(payload.schemaVersion, 1);
            assert.equal(payload.requestId, envelope.requestId);
            assert.equal(payload.command, envelope.command);
            assert.equal(payload.ok, true);
            assert.equal(payload.data?.status, 'unknown');
            assert.equal(payload.data?.originalRequestId, body.originalRequestId);
          } else {
            assertBackfillEnvelope(payload, envelope, outcome, count);
          }
        };
        const baseBody = { teamName, teamId: teamName, taskId, memberName, laneId,
          projectDir, workspaceRoot: projectPath, attributionMode: 'compatible' };
        try { invoke('control', { originalRequestId: 'never-submitted-fixture' }); }
        catch (error) { item.controlError = error.stack || String(error); }
        invoke('empty', baseBody, 'no-history', 0);
        assert.equal(existsSync(path.join(projectDir, '.board-task-changes/events/task-1.jsonl')), false);
        const fixture = createBackfillFixture(env, projectPath, projectDir);
        item.fixtureDbSha256 = sha256(readFileSync(fixture.dbPath));
        invoke('import', fixture.body, 'imported', 1);
        item.ledger = assertImportedLedger(projectDir);
        invoke('replay', fixture.body, 'duplicates-only', 0);
        assert.deepEqual(assertImportedLedger(projectDir), item.ledger);
        // Importing evidence must never apply the reconstructed write to the workspace.
        assert.equal(existsSync(path.join(projectPath, 'fixture.txt')), false);
        const probes = readFileSync(path.join(caseRoot, 'fake-opencode-invocations.jsonl'), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        assert.ok(probes.some(probe => probe.argv.slice(2).includes('--version')),
          'backfill must exercise the fake OpenCode child probe');
        item.passed = !item.controlError;
      } catch (error) {
        item.error = error.stack || String(error);
      } finally {
        const log = path.join(caseRoot, 'fake-opencode-invocations.jsonl');
        if (existsSync(log)) item.probeInvocations = readFileSync(log, 'utf8');
        flush();
      }
    }
  } finally {
    finishSmokeCleanup(report, root);
    flush();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = runBackfillSmoke(process.argv[2] || path.join('dist', 'cli.exe'), process.argv[3]);
  assert.equal(report.passed, true, 'Packaged Windows backfill failed; see evidence JSON');
}
