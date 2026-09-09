import assert from 'node:assert/strict';
import childProcess, { spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { assertBackfillEnvelope, assertImportedLedger, buildWindowsTeardownCommand, createBackfillFixture, finishSmokeCleanup, runSmokeGroups, sandboxEnvironment, teardownOwnedProcesses, trustedSearchPath, windowsNodeScriptPattern } from './windows-runtime-opencode-backfill.mjs';

import { assertReadinessHost, runProviderSmoke, runRecordedCheck } from './windows-runtime-opencode-provider-json.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const existingBun = () => (process.env.PATH || '').split(path.delimiter)
  .map(dir => path.join(dir, process.platform === 'win32' ? 'bun.exe' : 'bun'))
  .find(candidate => existsSync(candidate));


// Real SQLite reader + attribution/reconstruction, without loading the full CLI,
// installing dependencies, compiling, starting a provider, or modifying a project.
test('fixture is readable and reconstructs one strictly attributed write through production readers', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'backfill-fixture-check-'));
  try {
    const workspace = path.join(root, 'workspace Юникод 世界');
    const project = path.join(root, 'ledger');
    mkdirSync(workspace); mkdirSync(project);
    const env = sandboxEnvironment(root, path.join(root, 'fake.cmd'));
    const fixture = createBackfillFixture(env, workspace, project);
    writeFileSync(path.join(root, 'fixture.json'), JSON.stringify(fixture));
    const reader = path.join(repository, 'src/services/opencode/OpenCodeOfflineSessionReader.ts');
    const reconstructor = path.join(repository, 'src/services/opencode/OpenCodeToolpartChangeReconstructor.ts');
    const program = `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      const { OpenCodeOfflineSessionReader } = await import(${JSON.stringify(reader)});
      const { OpenCodeToolpartChangeReconstructor } = await import(${JSON.stringify(reconstructor)});
      const fixture = JSON.parse(readFileSync(${JSON.stringify(path.join(root, 'fixture.json'))}, 'utf8'));
      const record = JSON.parse(readFileSync(${JSON.stringify(path.join(env.CLAUDE_MULTIMODEL_DATA_HOME, 'opencode/session-store.json'))}, 'utf8')).records.fixture;
      const offline = await new OpenCodeOfflineSessionReader().readSession(record);
      assert.equal(offline.historyShape, 'supported');
      assert.equal(offline.rawMessages.length, 2);
      assert.equal(offline.rawParts.length, 2);
      const input = { teamName: fixture.body.teamName, memberName: record.memberName,
        sessionId: record.opencodeSessionId, projectPath: record.projectPath,
        rawMessages: offline.rawMessages, rawParts: offline.rawParts,
        requestedTask: { taskId: fixture.body.taskId, teamName: fixture.body.teamName },
        laneId: record.laneId, attributionMode: 'strict-delivery',
        deliveryContext: JSON.parse(readFileSync(fixture.body.deliveryContextPath, 'utf8')) };
      const result = new OpenCodeToolpartChangeReconstructor().reconstruct(input);
      assert.equal(result.changes.length, 1, JSON.stringify(result));
      assert.equal(result.changes[0].taskId, 'task-1');
      assert.equal(result.changes[0].relativePath, 'fixture.txt');
      assert.equal(result.changes[0].operation, 'create');
      assert.equal(result.changes[0].sourcePartId, 'write-1');
      assert.equal(result.changes[0].afterContent, JSON.parse(offline.rawParts[1].data).state.input.content);
      const wrongTask = new OpenCodeToolpartChangeReconstructor().reconstruct({ ...input,
        requestedTask: { taskId: 'another-task', teamName: input.teamName } });
      assert.equal(wrongTask.changes.length, 0);
    `;
    const bun = existingBun();
    assert.ok(bun, 'Existing Bun required; this test never installs it');
    const result = spawnSync(bun, ['--eval', program], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a successful process alone cannot satisfy domain and request assertions', () => {
  const envelope = { schemaVersion: 1, requestId: 'fixture', command: 'opencode.backfillTaskLedger',
    body: { teamName: 'fixture', taskId: 'task-1', projectDir: '/fixture', workspaceRoot: '/workspace', attributionMode: 'strict-delivery' } };
  const payload = { schemaVersion: 1, requestId: envelope.requestId, command: envelope.command, ok: true,
    data: { ...envelope.body, schemaVersion: 1, providerId: 'opencode', opencodeTaskLedgerEvidenceContractVersion: 1,
      dryRun: false, outcome: 'imported', importedEvents: 1, scannedSessions: 1, candidateEvents: 1 } };
  assertBackfillEnvelope(payload, envelope, 'imported', 1);
  for (const mutate of [
    value => { value.ok = false; }, value => { value.command = 'opencode.handshake'; },
    value => { value.requestId = 'stale-output'; }, value => { value.data.outcome = 'no-attribution'; },
    value => { value.data.importedEvents = 0; }, value => { value.data.workspaceRoot = '/wrong'; },
  ]) {
    const invalid = structuredClone(payload); mutate(invalid);
    assert.throws(() => assertBackfillEnvelope(invalid, envelope, 'imported', 1));
  }
});

test('ledger assertion rejects wrong content, wrong task, and duplicate imports', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'backfill-ledger-oracle-'));
  try {
    const ledger = path.join(root, '.board-task-changes');
    mkdirSync(path.join(ledger, 'events'), { recursive: true });
    mkdirSync(path.join(ledger, 'blobs/sha256'), { recursive: true });
    const content = 'Fixture only: spaces, "quotes", C:\\fake\\path, Привет 世界\n';
    const digest = hash(content);
    const blob = path.join(ledger, 'blobs/sha256', digest);
    writeFileSync(blob, content);
    const event = { taskId: 'task-1', memberName: 'bob', relativePath: 'fixture.txt', sourceRuntime: 'opencode',
      sourceSessionId: 'session-bob', sourcePartId: 'write-1', sourceMessageId: 'assistant-1',
      source: 'opencode_toolpart_write', operation: 'create', after: { sha256: digest, blobRef: `sha256/${digest}` } };
    const journal = path.join(ledger, 'events/task-1.jsonl');
    writeFileSync(journal, JSON.stringify(event) + '\n');
    assertImportedLedger(root);
    writeFileSync(blob, 'corrupt');
    assert.throws(() => assertImportedLedger(root));
    writeFileSync(blob, content);
    writeFileSync(journal, JSON.stringify({ ...event, taskId: 'wrong-task' }) + '\n');
    assert.throws(() => assertImportedLedger(root));
    writeFileSync(journal, (JSON.stringify(event) + '\n').repeat(2));
    assert.throws(() => assertImportedLedger(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows PATH contains only trusted Node, System32 and Windows PowerShell directories', () => {
  assert.deepEqual(trustedSearchPath('win32', 'C:\\trusted node\\node.exe', 'C:\\Windows').split(';'), [
    'C:\\trusted node', 'C:\\Windows\\System32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  ]);
});

test('cleanup errors override successful assertions and preserve the remaining root', () => {
  const root = '/isolated/fixture';
  const report = { passed: true, cases: [{ passed: true }] };
  const order = [];
  finishSmokeCleanup(report, root, {
    teardown: () => order.push('teardown'),
    remove: () => { order.push('remove'); throw new Error('forced EBUSY after retries'); },
  });
  assert.deepEqual(order, ['teardown', 'remove']);
  assert.equal(report.passed, false);
  assert.equal(report.remainingRoot, root);
  assert.match(report.cleanupError, /EBUSY/);
  const teardownFailure = { passed: true, cases: [{ passed: true }] };
  finishSmokeCleanup(teardownFailure, root, {
    teardown: () => { throw new Error('identity unavailable'); }, remove: () => {},
  });
  assert.equal(teardownFailure.passed, false);
  assert.match(teardownFailure.cleanupError, /identity unavailable/);
});

test('teardown retains the last phase on timeout or failure and keeps stdout separate', t => {
  const error = Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const stderr = 'teardown: started\nteardown: before import Microsoft.PowerShell.Management\n';
  let result;
  const env = { HOME: '/isolated/home' };
  t.mock.method(childProcess, 'spawnSync', (executable, argv, options) => {
    assert.equal(executable, 'powershell.exe');
    assert.deepEqual(argv.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    assert.equal(options.env, env);
    assert.equal(options.timeout, 30000);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    // Check emitted diagnostic boundaries; native execution remains Windows-only.
    const command = argv.at(-1);
    for (const [phase, operation] of [
      ...['Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility']
        .map(name => [`import ${name}`, `Import-Module ${name} -ErrorAction Stop`]),
      ['load System.Management', "[void][System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')"],
      ['script enumeration', '$scripts = @(Get-ChildItem -LiteralPath'],
      ['process enumeration', '$entries = @(Read-ProcessEntries)'],
      ['Get-Process', '$target = Get-Process -Id'],
      ['hold handle', '$heldHandle = $target.Handle'],
      ['identity query', '$current = Read-ProcessEntries (" WHERE ProcessId = " + $entry.ProcessId)'],
      ['identity validation', "throw 'Owned process identity changed during cleanup'"],
      ['kill', '$target.Kill()'],
      ['wait for exit', '$target.WaitForExit(5000)'],
      ['dispose', '$target.Dispose()'],
      ['JSON output', 'ConvertTo-Json -InputObject $stopped'],
    ]) {
      const before = command.indexOf(`[Console]::Error.WriteLine('teardown: before ${phase}`);
      const after = command.indexOf(`[Console]::Error.WriteLine('teardown: after ${phase}`);
      assert.ok(before >= 0 && before < command.indexOf(operation) && command.indexOf(operation) < after, phase);
    }
    assert.doesNotMatch(command, /Import-Module CimCmdlets|Get-CimInstance|Get-WmiObject|Add-Type/);
    assert.ok(command.includes("[System.Management.ManagementObjectSearcher]::new('SELECT ProcessId, ExecutablePath, CommandLine, CreationDate FROM Win32_Process' + $filter)"));
    for (const name of ['ProcessId', 'ExecutablePath', 'CommandLine', 'CreationDate']) {
      assert.ok(command.includes(`$row.GetPropertyValue('${name}')`));
      assert.ok(!command.includes(`$row.${name}`), 'Projection must not depend on the WMI adapter');
    }
    assert.ok(command.includes('[System.Management.ManagementDateTimeConverter]::ToDateTime($creationDate)'));
    assert.ok(command.includes("$entry.CreationDate.ToUniversalTime().ToString('o')"));
    for (const dispose of ['$row.Dispose()', '$results.Dispose()', '$searcher.Dispose()']) assert.ok(command.includes(dispose));
    // Missing creation time must fail closed; the held handle and ownership
    // re-read must precede the only kill. This checks construction, not native WMI.
    const guard = command.indexOf("if ($null -eq $entry.CreationDate -or $current.CreationDate -ne $entry.CreationDate -or -not (Is-Owned $current)) { throw 'Owned process identity changed during cleanup' }");
    assert.ok(guard > command.indexOf('$current = Read-ProcessEntries'));
    assert.ok(command.indexOf('$heldHandle = $target.Handle') < command.indexOf('$current = Read-ProcessEntries'));
    assert.ok(guard < command.indexOf('$target.Kill()'));
    return result;
  });
  syncBuiltinESMExports();
  try {
    for (result of [
      { status: null, signal: 'SIGTERM', stdout: '', stderr, error },
      { status: 1, signal: null, stdout: '', stderr },
      { status: 0, signal: null, stdout: '[]\n', stderr: 'teardown: after JSON output\n' },
    ]) {
      const report = {};
      if (result.error) assert.throws(() => teardownOwnedProcesses('/isolated', report, env), caught => caught === error);
      else if (result.status) assert.throws(() => teardownOwnedProcesses('/isolated', report, env), /Owned-process teardown failed/);
      else teardownOwnedProcesses('/isolated', report, env);
      assert.equal(report.teardown.stderr, result.stderr);
      assert.equal(report.teardown.stdout, result.stdout);
      assert.equal(report.teardown.errorCode, result.error?.code);
      assert.equal(report.teardown.signal, result.signal);
      assert.equal(report.teardown.timeoutMs, 30000);
      assert.ok(Number.isFinite(report.teardown.elapsedMs));
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('ownership diagnostics are bounded to explicit fixture candidates and cannot authorize a kill', () => {
  const command = buildWindowsTeardownCommand('/isolated', [null, -1, 1.5, 0x80000000, '2; exit', ...Array.from({ length: 12 }, (_, i) => i + 101)]);
  assert.ok(command.includes('$diagnosticPids = @(101, 102, 103, 104, 105, 106, 107, 108)'));
  const predicate = command.slice(command.indexOf('function Is-Owned'), command.indexOf('function Read-ProcessEntries'));
  assert.doesNotMatch(predicate, /diagnosticPids/);
  assert.ok(predicate.includes('Get-OwnershipPath $entry.ExecutablePath'));
  assert.ok(predicate.includes('Get-OwnershipPath $commandScript'));
  assert.ok(predicate.includes('$scripts -icontains $scriptPath'));
  assert.ok(command.includes('if ($diagnosticPids -contains $entry.ProcessId)'));
  assert.ok(command.includes('[Math]::Min(512, $value.Length)'));
  assert.ok(command.includes('if (-not $owned) { continue }'));
  assert.equal(command.match(/\$target\.Kill\(\)/g).length, 1);
});

test('readiness rejects a degraded host even with a successful envelope', () => {
  const payload = { ok: true, command: 'opencode.readiness', data: { hostHealthy: true } };
  assertReadinessHost(payload);
  assert.throws(() => assertReadinessHost({ ...payload, data: { hostHealthy: false } }));
  assert.throws(() => assertReadinessHost({ ...payload, data: {} }));
});

test('combined evidence runs all provider checks after backfill or provider failure', () => {
  // Exercise the real provider harness with injected process results, including
  // file output. No packaged binary, provider process or Windows simulation claim.
  for (const failedGroup of ['none', 'backfill', 'providers-view', 'handshake-file', 'handshake-stdout', 'readiness-stdout', 'provider-cleanup']) {
    const snapshots = [];
    const report = {};
    const labels = ['providers-view', 'handshake-file', 'handshake-stdout', 'readiness-stdout'];
    let calls = 0;
    runSmokeGroups(report, {
      backfill: group => {
        if (failedGroup === 'backfill') throw new Error('forced backfill failure');
        group.passed = true;
      },
      provider: (group, flush) => runProviderSmoke('/fixture/runtime.exe', group, flush, {
        spawn: (executable, argv) => {
          const label = labels[calls++];
          const payload = label === 'providers-view'
            ? { runtimeId: 'opencode', view: { providers: [{ providerId: 'opencode' }] } }
            : label === 'readiness-stdout'
              ? { ok: false, command: 'opencode.readiness', data: { hostHealthy: true } }
              : { ok: true, command: 'opencode.handshake', requestId: 'runtime-opencode-smoke' };
          const stdout = JSON.stringify(payload);
          const outputIndex = argv.indexOf('--output');
          if (outputIndex >= 0) writeFileSync(argv[outputIndex + 1], stdout);
          return { pid: 123, status: label === failedGroup ? 1 : 0, signal: null,
            stdout, stderr: label === failedGroup ? 'forced provider failure: exact stderr' : '' };
        },
        cleanup: (group, root) => {
          try {
            finishSmokeCleanup(group, root, {
              teardown: () => {},
              remove: (...args) => {
                if (failedGroup === 'provider-cleanup') throw new Error('forced cleanup EBUSY');
                rmSync(...args);
              },
            });
          } finally { rmSync(root, { recursive: true, force: true }); }
        },
      }),
    }, () => snapshots.push(structuredClone(report)));
    assert.equal(calls, 4);
    assert.equal(report.passed, failedGroup === 'none');
    assert.equal(snapshots.at(-1).passed, report.passed);
    assert.equal(report.groups.provider.cases.length, 4);
    if (failedGroup === 'provider-cleanup') {
      assert.equal(report.groups.backfill.passed, true);
      assert.equal(report.groups.provider.passed, false);
      assert.match(report.groups.provider.cleanupError, /EBUSY/);
      assert.ok(report.groups.provider.remainingRoot);
    }
    for (const item of report.groups.provider.cases) {
      assert.equal(item.executable, '/fixture/runtime.exe');
      assert.equal(item.argv[0], 'runtime');
      assert.equal(typeof item.stdout, 'string');
      assert.equal('env' in item, false);
      assert.equal(item.passed, item.label !== failedGroup);
      if (item.label === failedGroup) {
        assert.equal(item.status, 1);
        assert.equal(item.stderr, 'forced provider failure: exact stderr');
      }
    }
    assert.ok(report.groups.provider.cases[1].output.includes('opencode.handshake'));
    assert.ok(snapshots.some(snapshot => snapshot.groups?.provider?.cases.some(item => item.passed === false)));
  }
});

test('spawn timeout records argv and stderr and fails the provider check', () => {
  const group = { cases: [] };
  const error = Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' });
  let validated = false;
  const item = runRecordedCheck(group, 'timeout', { executable: '/fixture/runtime.exe', argv: ['runtime'], cwd: '/fixture' },
    () => { validated = true; }, { spawn: () => ({ pid: 321, status: null, signal: 'SIGTERM', stdout: '', stderr: 'before timeout', error }) });
  assert.equal(validated, false);
  assert.equal(item.passed, false);
  assert.equal(item.stderr, 'before timeout');
  assert.deepEqual(item.argv, ['runtime']);
  assert.match(item.error, /ETIMEDOUT/);
});

test('Windows script argument parsing requires a complete exact path', () => {
  const node = String.raw`C:\trusted node\node.exe`;
  for (const script of [String.raw`C:\isolated\fake-opencode.cjs`, String.raw`C:\isolated space 世界\fake-opencode.cjs`]) {
    const pattern = new RegExp(windowsNodeScriptPattern, 'i');
    const scriptArgument = command => {
      const groups = pattern.exec(command)?.groups;
      return groups?.quotedScript || groups?.bareScript;
    };
    assert.equal(scriptArgument(`"${node}" "${script}"`), script);
    assert.equal(scriptArgument(`"${node}" "${script}" --port 1234`), script);
    assert.equal(scriptArgument(`node.exe "${script}"`), script);
    for (const command of [
      `"${node}" "${script} unrelated-helper.cjs"`,
      `"${node}" "${script} unrelated-helper.cjs" --port 1234`,
      `"${node}" "${script}.other"`,
      `"${node}" "${script}"suffix`,
      `"${node}" "${script}`, // missing closing quote
      `"${node}" ${script}\u00a0unrelated.cjs`, // NBSP is not a Windows argument separator
      `"${node}" "${script}"\u00a0unrelated.cjs`,
    ]) assert.notEqual(scriptArgument(command), script, command);
    if (/\s/.test(script)) assert.notEqual(scriptArgument(`"${node}" ${script}`), script);
    else assert.equal(scriptArgument(`"${node}" ${script} --port 1234`), script);
  }
});

// Native failure evidence is flushed before and after every bounded invocation,
// including an empty-output timeout. Only the sandbox allowlist is passed; never
// retry against the runner's real home, PATH, credentials or provider config.
function recordWindowsProbe(evidence, flush, label, executable, argv, options) {
  const item = { label, executable, argv, cwd: options.cwd, stdio: options.stdio,
    timeoutMs: options.timeout, startedAt: new Date().toISOString(), state: 'running' };
  evidence.probes.push(item);
  flush();
  const started = performance.now();
  const result = spawnSync(executable, argv, { encoding: 'utf8', maxBuffer: 64 * 1024,
    windowsHide: true, ...options });
  Object.assign(item, { state: 'finished', elapsedMs: Math.round(performance.now() - started),
    pid: result.pid, status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr,
    error: result.error ? { message: result.error.message, code: result.error.code,
      errno: result.error.errno, syscall: result.error.syscall } : null });
  flush();
  return item;
}

// Every invocation imports the actual helper in a fresh Bun process. Repeats are
// ordered diagnostics, never substitutes for the first acceptance result.
function productionIdentityProbe(evidence, flush, bun, env, root, pid, attempt) {
  assert.ok(bun, 'Existing Bun required; this test never installs it');
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Fixture PID required');
  const processKill = path.join(repository, 'src/utils/processKill.ts');
  const program = `
    console.error(JSON.stringify({ phase: 'before-production-import', attempt: ${attempt}, bunVersion: Bun.version }));
    const { readProcessStartTimeMs } = await import(${JSON.stringify(processKill)});
    console.error(JSON.stringify({ phase: 'before-production-query', attempt: ${attempt}, bunVersion: Bun.version }));
    const started = performance.now();
    const startedAtMs = await readProcessStartTimeMs(${pid});
    console.error(JSON.stringify({ phase: 'after-production-query', attempt: ${attempt}, elapsedMs: performance.now() - started, startedAtMs }));
    console.log(JSON.stringify({ startedAtMs }));
  `;
  return recordWindowsProbe(evidence, flush, attempt === 1 ? 'production-identity' : `production-identity-repeat-${attempt - 1}`,
    bun, ['--eval', program], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
}

// Execute the real emitted projection and predicate without its kill loop.
// Run after the first production identity so this cannot warm its cold query.
function nativeOwnershipProbe(evidence, flush, env, root, pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff, 'Fixture PID required');
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const prefix = buildWindowsTeardownCommand(root, [pid]).split('$stopped = @()')[0];
  assert.doesNotMatch(prefix, /\.Kill\(/);
  const script = path.join(root, 'fake-opencode.cjs');
  const longScript = realpathSync.native(script);
  const entry = commandLine => ({ ExecutablePath: process.execPath, CommandLine: commandLine });
  const quoted = value => `"${value}"`;
  const cases = [
    [true, entry(`${quoted(process.execPath)} ${quoted(script)}`)],
    [true, entry(`${quoted(realpathSync.native(process.execPath))} ${quoted(longScript)} --port 1234`)],
    [true, entry(`node.exe ${quoted(script)}`)],
    [false, entry(`${quoted(process.execPath)} ${quoted(script + ' unrelated-helper.cjs')}`)],
    [false, entry(`${quoted(process.execPath)} ${quoted(script)}suffix`)],
    [false, entry(`${quoted(process.execPath)} ${quoted(script)}\u00a0unrelated.cjs`)],
    [false, entry(`${quoted(process.execPath)} --require ${quoted(script)}`)],
    [false, entry(`${quoted(process.execPath)} fake-opencode.cjs`)],
    [false, entry(`${quoted(process.execPath)} ${quoted(path.join(root + '-sibling', 'fake-opencode.cjs'))}`)],
    [false, { ...entry(`node.exe ${quoted(script)}`), ExecutablePath: null }],
    [false, { ...entry(`node.exe ${quoted(script)}`), ExecutablePath: path.join(root + '-sibling', 'node.exe') }],
  ];
  const command = prefix + `
$expectedScript = ${literal(longScript)}
if ((Get-OwnershipPath ${literal(script)}) -ine $expectedScript) { throw 'Short/long fixture paths disagree' }
$cases = ConvertFrom-Json ${literal(JSON.stringify(cases))}
foreach ($case in $cases) {
  if ([bool](Is-Owned $case[1]) -ne $case[0]) { throw 'Exact argv ownership regression' }
}
$rows = @(Read-ProcessEntries ' WHERE ProcessId = ${pid}')
if ($rows.Count -ne 1 -or $rows[0].ProcessId -ne ${pid} -or -not $rows[0].CreationDate -or -not (Is-Owned $rows[0])) { throw 'Actual fixture WMI projection/ownership failed' }
ConvertTo-Json -InputObject @{ cases = $cases.Count; startedAt = $rows[0].CreationDate.ToUniversalTime().ToString('o'); inputScript = ${literal(script)}; longScript = $expectedScript } -Compress
`;
  const probe = recordWindowsProbe(evidence, flush, 'fixture-ownership-contract', 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  assert.ok(!probe.error && probe.status === 0, `Fixture ownership contract failed: ${JSON.stringify(probe)}`);
  const result = JSON.parse(probe.stdout);
  assert.equal(result.cases, cases.length);
  assert.equal(Date.parse(result.startedAt), evidence.startedAtMs);
}

// Run every evidence/assertion phase, then rethrow the original failure object.
// In particular, diagnostics, teardown, and cleanup cannot replace identity failure.
async function runNativePhases(evidence, flush, phases) {
  let firstError;
  evidence.phases = [];
  const save = () => {
    try { flush(); }
    catch (error) {
      firstError ??= error;
      evidence.error ??= error.stack || String(error);
      (evidence.writeErrors ??= []).push(error.stack || String(error));
    }
  };
  for (const [label, run] of phases) {
    const phase = { label, state: 'running' };
    evidence.phases.push(phase);
    save(); // Evidence I/O must not bypass teardown or the remaining assertions.
    try { await run(); phase.state = 'passed'; }
    catch (error) {
      firstError ??= error;
      phase.state = 'failed';
      phase.error = error.stack || String(error);
      evidence.error ??= phase.error;
    }
    save();
  }
  if (firstError) throw firstError;
}

function nativeTeardownPhases(evidence, children, getExited) {
  let stopped;
  return [
    ['teardown-identity-marker', () => assert.match(evidence.teardown?.stderr ?? '', /teardown: after identity validation pid=/)],
    ['teardown-exit-marker', () => assert.match(evidence.teardown?.stderr ?? '', /teardown: after wait for exit pid=/)],
    ['teardown-json-marker', () => assert.match(evidence.teardown?.stderr ?? '', /teardown: after JSON output/)],
    ['owned-child-exited', async () => {
      // A failed teardown is a failed condition, not a reason to wait another
      // 35s or silently skip the assertion. Other checks still run independently.
      assert.equal(evidence.teardown?.status, 0, 'Teardown must finish successfully');
      assert.ok(getExited(), 'Owned fixture must have started');
      await getExited();
    }],
    ['teardown-json', () => { stopped = JSON.parse(evidence.teardown?.stdout); assert.ok(Array.isArray(stopped)); }],
    ['owned-child-stopped', () => assert.ok(stopped?.some(entry => entry.pid === children[0]?.pid))],
    ['first-identity-matches-teardown', () => {
      assert.ok(Number.isFinite(evidence.startedAtMs), 'First production identity must succeed; repeats cannot satisfy this gate');
      assert.equal(Date.parse(stopped?.find(entry => entry.pid === children[0]?.pid)?.startedAt), evidence.startedAtMs,
        'teardown must identify the same process creation time as the first production query');
    }],
    ['only-owned-child-stopped', () => assert.ok(stopped?.every(entry =>
      entry.pid !== process.pid && entry.pid !== children[1]?.pid && entry.pid !== children[2]?.pid))],
    // These survival checks run independently even after teardown throws,
    // invalid JSON, missing phase markers, or a previous survival failure.
    ['parent-survived', () => assert.equal(process.kill(process.pid, 0), true, 'parent Node remains alive')],
    ...[1, 2].map(index => [index === 1 ? 'unrelated-survived' : 'shared-prefix-survived', () => {
      assert.ok(children[index]?.pid, 'Negative fixture must have started');
      assert.equal(process.kill(children[index].pid, 0), true, 'Unowned Node fixture remains alive');
      (evidence.survivingUnrelatedPids ??= []).push(children[index].pid);
    }]),
  ];
}

function diagnoseWindowsStartup(evidence, flush, env, root, pid) {
  const absolute = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const startup = "[Console]::Out.WriteLine('powershell-started')";
  const identity = `${startup}; $ErrorActionPreference = 'Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`;
  const directIdentity = `${startup}; $ErrorActionPreference = 'Stop'; [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().ToString('o')`;
  const moduleIdentity = `${startup}; $ErrorActionPreference = 'Stop'; Import-Module Microsoft.PowerShell.Management; [Console]::Out.WriteLine('management-loaded'); (Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`;
  // These approximate query/startup controls are diagnostic only, not copies
  // of the production acceptance helper. Piped input reproduces the old harness
  // mode. None of these results can make the test pass.
  for (const [label, executable, command, stdin] of [
    ['bare-startup-ignore-stdin', 'powershell.exe', startup, 'ignore'],
    ['absolute-startup-ignore-stdin', absolute, startup, 'ignore'],
    ['absolute-identity-ignore-stdin', absolute, identity, 'ignore'],
    ['absolute-dotnet-identity', absolute, directIdentity, 'ignore'],
    ['absolute-module-identity', absolute, moduleIdentity, 'ignore'],
    ['absolute-startup-pipe-stdin', absolute, startup, 'pipe'],
  ]) recordWindowsProbe(evidence, flush, label, executable,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env, cwd: root, stdio: [stdin, 'pipe', 'pipe'], timeout: 2500 });
}

test('native probe evidence retains an empty-output timeout and its invocation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'backfill-probe-evidence-'));
  try {
    const evidence = { probes: [] };
    const snapshots = [];
    const env = sandboxEnvironment(root, path.join(root, 'opencode.cmd'));
    const argv = ['--eval', 'setInterval(() => {}, 1000)'];
    const item = recordWindowsProbe(evidence, () => snapshots.push(structuredClone(evidence)),
      'empty-output-timeout', process.execPath, argv,
      { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 250 });
    assert.equal(item.error.code, 'ETIMEDOUT');
    assert.equal(item.stdout, '');
    assert.equal(item.stderr, '');
    assert.equal(item.status, null);
    assert.equal(item.executable, process.execPath);
    assert.deepEqual(item.argv, argv);
    assert.equal(item.timeoutMs, 250);
    assert.ok(item.elapsedMs >= 200);
    assert.equal('env' in item, false);
    assert.equal(snapshots[0].probes[0].state, 'running');
    assert.equal(snapshots[1].probes[0].state, 'finished');
    assert.equal(snapshots[1].probes[0].error.code, 'ETIMEDOUT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Linux wiring only: do not warm PowerShell before the native Windows first query.
test('production probe runs the actual helper twice through fresh Bun with timing markers', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'backfill-production-probe-'));
  try {
    const evidence = { probes: [] };
    const env = sandboxEnvironment(root, path.join(root, 'opencode.cmd'));
    const bun = existingBun();
    for (const attempt of [1, 2]) {
      const query = productionIdentityProbe(evidence, () => {}, bun, env, root, process.pid, attempt);
      assert.equal(query.status, 0, query.stderr);
      assert.equal(query.error, null);
      const value = JSON.parse(query.stdout).startedAtMs;
      assert.ok(Number.isFinite(value)); // Linux start ticks, not Windows milliseconds
      const markers = query.stderr.trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(markers.map(item => item.phase), ['before-production-import', 'before-production-query', 'after-production-query']);
      assert.ok(markers.every(item => item.attempt === attempt));
      assert.equal(markers.at(-1).startedAtMs, value);
      assert.ok(markers.at(-1).elapsedMs >= 0);
      assert.equal(query.timeoutMs, 10000);
    }
    assert.deepEqual(evidence.probes.map(item => item.label), ['production-identity', 'production-identity-repeat-1']);
    assert.equal(evidence.probes[0].stdout, evidence.probes[1].stdout);
    assert.equal(evidence.startedAtMs, undefined, 'Recording diagnostics does not set acceptance identity');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native failure collection keeps first failure and enforces every teardown and survival gate', async t => {
  const children = [{ pid: 101 }, { pid: 102 }, { pid: 103 }];
  const timestamp = '2026-09-09T03:26:43.616Z';
  const firstFailure = new Error('original first identity failure');
  const writeFailure = new Error('evidence disk write failed');
  const teardownFailure = Object.assign(new Error('teardown timeout'), { code: 'ETIMEDOUT' });
  let result;
  let deadPid;
  let checked;
  t.mock.method(childProcess, 'spawnSync', () => result);
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(signal, 0);
    checked.push(pid);
    if (pid === deadPid) throw new Error('negative fixture killed');
    return true;
  });
  syncBuiltinESMExports();
  try {
    for (const scenario of ['pass', 'first-failed-repeat-succeeded', 'first-and-teardown-failed',
      'evidence-write-failed', 'first-and-evidence-write-failed',
      'teardown-failed', 'bad-json', 'empty-stopped', 'wrong-identity', 'missing-identity', 'unrelated-stopped', 'parent-dead', 'unrelated-dead', 'shared-prefix-dead']) {
      const evidence = {};
      const snapshots = [];
      checked = [];
      deadPid = { 'parent-dead': process.pid, 'unrelated-dead': 102, 'shared-prefix-dead': 103 }[scenario];
      const firstFailed = scenario.startsWith('first-');
      result = { status: 0, stdout: JSON.stringify([{ pid: 101, startedAt: timestamp }]),
        stderr: 'teardown: after identity validation pid=101\nteardown: after wait for exit pid=101\nteardown: after JSON output\n' };
      if (scenario.includes('teardown-failed')) result = { status: null, stdout: '', stderr: 'teardown: started\n', error: teardownFailure };
      if (scenario === 'bad-json') result.stdout = 'invalid';
      if (scenario === 'empty-stopped') result.stdout = '[]';
      if (scenario === 'wrong-identity') result.stdout = JSON.stringify([{ pid: 101, startedAt: '2020-01-01T00:00:00Z' }]);
      if (scenario === 'missing-identity') result.stdout = JSON.stringify([{ pid: 101 }]);
      if (scenario === 'unrelated-stopped') result.stdout = JSON.stringify([{ pid: 101, startedAt: timestamp }, { pid: 102 }]);
      const run = runNativePhases(evidence, () => {
        snapshots.push(structuredClone(evidence));
        // Fail after the first phase has produced its result, then recover so
        // later evidence can still be written. Teardown and all gates must run.
        if (scenario.includes('evidence-write-failed') && snapshots.length === 2) throw writeFailure;
      }, [
        ['first-production-identity', () => {
          if (firstFailed) throw firstFailure;
          evidence.startedAtMs = Date.parse(timestamp);
        }],
        ['diagnostic-production-repeat-1', () => { evidence.probes = [{ stdout: JSON.stringify({ startedAtMs: Date.parse(timestamp) }) }]; }],
        ['owned-teardown', () => teardownOwnedProcesses('/isolated', evidence, {})],
        ...nativeTeardownPhases(evidence, children, () => Promise.resolve()),
      ]);
      if (scenario === 'pass') await run;
      else await assert.rejects(run, error => firstFailed ? error === firstFailure
        : scenario === 'teardown-failed' ? error === teardownFailure
          : scenario === 'evidence-write-failed' ? error === writeFailure : error instanceof Error);
      assert.equal(evidence.teardown.stderr, result.stderr, scenario);
      assert.equal(evidence.writeErrors?.length ?? 0, scenario.includes('evidence-write-failed') ? 1 : 0);
      assert.deepEqual(checked, [process.pid, 102, 103], scenario);
      assert.ok(evidence.phases.every(phase => phase.state !== 'running'), scenario);
      assert.deepEqual(evidence.phases.slice(-3).map(phase => phase.state),
        [process.pid, 102, 103].map(pid => pid === deadPid ? 'failed' : 'passed'), scenario);
      assert.equal(evidence.phases.find(phase => phase.label === 'first-identity-matches-teardown').state,
        firstFailed || ['teardown-failed', 'bad-json', 'empty-stopped', 'wrong-identity', 'missing-identity'].includes(scenario) ? 'failed' : 'passed', scenario);
      if (scenario === 'empty-stopped') assert.equal(evidence.phases.find(phase => phase.label === 'owned-child-stopped').state, 'failed');
      if (firstFailed) assert.equal(evidence.startedAtMs, undefined, 'Repeat success cannot replace first identity');
      assert.equal(snapshots.at(-1).phases.at(-1).state, evidence.phases.at(-1).state);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

// Retain the coordinator's 90s outer watchdog to include diagnostics and teardown;
// no 30s identity retry. Production itself has a 2.5s PowerShell query deadline.
test('Windows isolated PATH captures identity and teardown stops only the owned fixture', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'backfill owned process-'));
  const env = sandboxEnvironment(root, path.join(root, 'opencode.cmd'));
  const evidence = { schemaVersion: 1, passed: false, platform: process.platform,
    arch: process.arch, osRelease: os.release(), node: process.version,
    harnessCommit: process.env.BACKFILL_RUNTIME_HARNESS_COMMIT || null,
    root, environmentKeys: Object.keys(env).sort(), searchPath: env.PATH,
    isolatedDirectories: { HOME: env.HOME, USERPROFILE: env.USERPROFILE, TEMP: env.TEMP,
      APPDATA: env.APPDATA, LOCALAPPDATA: env.LOCALAPPDATA }, probes: [], children: [] };
  const evidencePath = process.env.BACKFILL_WINDOWS_TEST_EVIDENCE;
  const flush = () => {
    if (evidencePath) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  };
  const children = [];
  let originalError;
  let startedAtMs;
  let exited;
  let bun;
  try {
    await runNativePhases(evidence, flush, [
      ['fixture-startup', async () => {
        const ready = [];
        for (const name of ['fake-opencode.cjs', 'unrelated-helper.cjs', 'fake-opencode.cjs unrelated-helper.cjs']) {
          const script = path.join(root, name);
          writeFileSync(script, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);");
          const child = spawn(process.execPath, [script], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
          children.push(child);
          evidence.children.push({ pid: child.pid, executable: process.execPath, argv: [script] });
          ready.push(Promise.all([
            once(child, 'spawn'),
            once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }),
          ]));
        }
        await Promise.all(ready);
        bun = existingBun();
      }],
      ['first-production-identity', () => {
        const query = productionIdentityProbe(evidence, flush, bun, env, root, children[0]?.pid, 1);
        try { startedAtMs = JSON.parse(query.stdout).startedAtMs; } catch { /* retained raw evidence */ }
        assert.ok(!query.error && query.status === 0 && Number.isFinite(startedAtMs),
          `Production Windows process identity failed: ${JSON.stringify(query)}`);
        evidence.startedAtMs = startedAtMs;
      }],
      // Collect repeats before PowerShell controls warm the runner further. Each
      // keeps the production 2.5s query deadline and existing 10s Bun outer bound.
      ['diagnostic-production-repeat-1', () => {
        productionIdentityProbe(evidence, flush, bun, env, root, children[0]?.pid, 2);
      }],
      ['diagnostic-startup-controls', () => {
        if (!Number.isFinite(evidence.startedAtMs) && children[0]?.pid) {
          diagnoseWindowsStartup(evidence, flush, env, root, children[0].pid);
        }
      }],
      ['fixture-ownership-contract', () => nativeOwnershipProbe(evidence, flush, env, root, children[0]?.pid)],
      ['owned-teardown', () => {
        const child = children[0];
        if (child?.pid) {
          exited = once(child, 'exit', { signal: AbortSignal.timeout(35000) });
          exited.catch(() => {});
        }
        // Always use the existing exact-ownership/held-handle implementation,
        // even when first identity or diagnostics failed. Never use a repeat PID identity.
        teardownOwnedProcesses(root, evidence, env);
      }],
      ...nativeTeardownPhases(evidence, children, () => exited),
    ]);
    evidence.passed = true;
  } catch (error) {
    originalError = error;
    evidence.error = error.stack || String(error);
  } finally {
    const cleanup = await Promise.allSettled(children.map(async child => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
        exited.catch(() => {});
        child.kill(); // only the ChildProcess handle created in this test
        await exited;
      }
    }));
    evidence.cleanupErrors = cleanup.filter(item => item.status === 'rejected').map(item => String(item.reason));
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); }
    catch (error) { evidence.cleanupErrors.push(String(error)); evidence.remainingRoot = root; }
    if (evidence.cleanupErrors.length) evidence.passed = false;
    try { flush(); }
    catch (error) {
      originalError ??= error;
      evidence.passed = false;
      evidence.error ??= error.stack || String(error);
      (evidence.writeErrors ??= []).push(error.stack || String(error));
    }
    if (!evidence.passed) t.diagnostic(JSON.stringify(evidence));
  }
  if (originalError) throw originalError;
  assert.deepEqual(evidence.cleanupErrors, [], 'Direct test-child cleanup must succeed');
});
