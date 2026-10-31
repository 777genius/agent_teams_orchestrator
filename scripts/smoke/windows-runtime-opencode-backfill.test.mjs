import './windows-runtime-opencode-launcher.test.mts';
import assert from 'node:assert/strict';
import childProcess, { spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertBackfillCasePath, assertBackfillEnvelope, assertImportedLedger, buildWindowsTeardownCommand, createBackfillFixture, finishSmokeCleanup, fixtureScriptPaths, runSmokeGroups, sandboxEnvironment, stageRuntimeDelivery, teardownOwnedProcesses,
  WINDOWS_BACKFILL_TEARDOWN_TIMEOUT_MS, trustedSearchPath, windowsNodeScriptPattern } from './windows-runtime-opencode-backfill.mjs';

import { actualProviderResult, actualProviderTransport, catalogGuard, assertReadinessHost, runProviderSmoke, runRecordedCheck } from './windows-runtime-opencode-provider-json.mjs';
import { environmentSummary, traceSpawn } from './windows-process-identity-probe.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const identityProbeModule = new URL('./windows-process-identity-probe.mjs', import.meta.url).href;
const hash = value => createHash('sha256').update(value).digest('hex');
const existingBun = () => (process.env.PATH || '').split(path.delimiter)
  .map(dir => path.join(dir, process.platform === 'win32' ? 'bun.exe' : 'bun'))
  .find(candidate => existsSync(candidate));

test('actual provider comparison rejects static fallback and requires the selected native identity and model', () => {
  const binary = 'C:\\TEST\\node_modules\\.bin\\opencode.cmd';
  const view = { runtimeId: 'opencode', view: { runtime: { cliPath: binary, version: '1.18.31' },
    providers: [{ providerId: 'deepinfra', state: 'connected' }], diagnostics: [] } };
  const models = { runtimeId: 'opencode', models: { providerId: 'deepinfra', catalogState: 'fresh',
    models: [{ providerId: 'deepinfra', modelId: 'deepinfra/TEST-local-catalog-model' }], diagnostics: [] } };
  assert.equal(actualProviderResult(view, 'view', binary).passed, true);
  assert.equal(actualProviderResult(models, 'models', binary).passed, true);
  // An explicit custom ID must not alias the canonical ID declared by this fixture.
  assert.equal(actualProviderResult(models, 'models_reported_id', binary).passed, false);
  const missing = { runtimeId: 'opencode', error: { code: 'provider-missing' } };
  assert.equal(actualProviderResult(missing, 'models_reported_id', binary, 1).passed, true);
  assert.equal(actualProviderResult(missing, 'models_reported_id', binary).passed, false);
  assert.equal(actualProviderResult({ ...missing, models: models.models }, 'models_reported_id', binary, 1).passed, false);
  assert.equal(actualProviderResult({ runtimeId: 'opencode', error: { code: 'provider-missing',
    message: 'Selected OpenCode identity is unavailable' } }, 'models_reported_id', binary, 1).passed, false);
  const reportedMismatch = structuredClone(models);
  reportedMismatch.models.providerId = 'deep-infra';
  reportedMismatch.models.models[0].modelId = 'deep-infra/TEST-local-catalog-model';
  assert.equal(actualProviderResult(reportedMismatch, 'models_reported_id', binary).passed, false);
  assert.equal(actualProviderResult(models, 'models', binary, 1).passed, false);
  const diagnostic = structuredClone(view);
  diagnostic.view.runtime.version = 'opencode v1.18.31';
  diagnostic.view.runtime.state = 'ready';
  diagnostic.view.providers = [{ providerId: 'deepinfra', state: 'available' },
    { providerId: 'deep-infra', state: 'connected' }, { providerId: 'TEST-secret', state: 'TEST-secret' }];
  const projected = actualProviderResult(diagnostic, 'view', binary);
  assert.equal(projected.passed, false);
  assert.equal(projected.versionClass, 'branded_expected');
  assert.equal(projected.runtimeState, 'ready');
  assert.equal(projected.deepinfraState, 'available');
  assert.equal(projected.deepInfraDisplayState, 'connected');
  assert.ok(!JSON.stringify(projected).includes('TEST-secret'));
  diagnostic.view.diagnostics = [
    'OpenCode host did not become healthy within 10000ms Diagnostics: TEST-secret',
    'OpenCode host did not become healthy within 10000ms',
    'Selected OpenCode identity is unavailable TEST-secret', 'TEST-secret',
  ];
  const classified = actualProviderResult(diagnostic, 'view', binary);
  assert.deepEqual(classified.diagnosticKinds, ['host_health_timeout', 'selected_identity', 'other']);
  assert.ok(!JSON.stringify(classified).includes('TEST-secret'));
  for (const [step, phase] of [['install managed OpenCode provider plugins', 'managed_plugins'],
    ['prepare managed OpenCode profile: create profile directories', 'profile'],
    ['opencode --version', 'version'], ['opencode providers list', 'providers'],
    ['opencode models --verbose', 'models'], ['opencode agent list', 'agents'], ['TEST-secret', 'other']]) {
    const snapshot = structuredClone(view);
    snapshot.view.diagnostics = [`OpenCode inventory probe timed out after 60000ms during ${step}`];
    const result = actualProviderResult(snapshot, 'view', binary);
    assert.equal(result.inventoryTimedOut, true); assert.equal(result.inventoryPhase, phase);
    assert.ok(!JSON.stringify(result).includes('TEST-secret'));
  }
  for (const mutate of [value => { value.view.runtime.cliPath = null; },
    value => { value.view.providers.push({ providerId: 'deep-infra', state: 'connected' }); },
    value => { value.view.runtime.version = '1.19.0'; },
    value => { value.view.providers[0].state = 'available'; },
    value => { value.view.diagnostics.push('capabilities_pending'); }]) {
    const invalid = structuredClone(view); mutate(invalid);
    assert.equal(actualProviderResult(invalid, 'view', binary).passed, false);
  }
  for (const mutate of [value => { value.models.catalogState = 'stale'; },
    value => { value.models.models[0].modelId = 'other-model'; },
    value => { value.models.providerId = 'other-provider'; }]) {
    const invalid = structuredClone(models); mutate(invalid);
    assert.equal(actualProviderResult(invalid, 'models', binary).passed, false);
  }
  const refused = actualProviderResult({ runtimeId: 'opencode', error: { code: 'runtime-unhealthy',
    message: 'Selected OpenCode identity is unavailable TEST-secret-do-not-persist' } }, 'models', binary);
  assert.equal(refused.identityUnavailable, true);
  assert.equal(refused.passed, false);
  assert.ok(!JSON.stringify(refused).includes('TEST-secret'));
  assert.deepEqual(actualProviderTransport({ code: 'ETIMEDOUT', killed: true, message: 'TEST-secret' }),
    { transport: 'ETIMEDOUT', killed: true });
  assert.deepEqual(actualProviderTransport({ code: 'TEST-secret', stderr: 'TEST-secret' }),
    { transport: 'other', killed: false });
});

test('catalog guard permits only exact read-only catalog/auth routes and rejects inference', () => {
  const observations = [];
  for (const [method, url, expected] of [['GET', '/v1/models', 200], ['GET', '/auth', 200],
    ['POST', '/v1/chat/completions', 405], ['POST', '/session/prompt', 405], ['GET', '/session', 405]]) {
    let status;
    catalogGuard({ method, url, resume() {} }, { writeHead(value) { status = value; }, end() {} }, observations);
    assert.equal(status, expected);
  }
  assert.deepEqual(observations, [{ allowed: true }, { allowed: true },
    { allowed: false }, { allowed: false }, { allowed: false }]);
});

test('sandbox environment leaves fresh SDK data uncreated and preserves existing data ownership and contents', () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'sdk-data-owner-')));
  try {
    const env = sandboxEnvironment(root, path.join(root, 'opencode.cmd'));
    assert.equal(env.CLAUDE_MULTIMODEL_DATA_HOME, path.join(root, 'data'));
    assert.equal(existsSync(env.CLAUDE_MULTIMODEL_DATA_HOME), false,
      'The delivered runtime must create its SDK data root through its native ownership boundary');
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP',
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
      'CLAUDE_CONFIG_DIR', 'CLAUDE_MULTIMODEL_CACHE_HOME']) {
      assert.equal(statSync(env[key]).isDirectory(), true, key + ' remains available to fixture children');
    }
    const existing = path.join(env.CLAUDE_MULTIMODEL_DATA_HOME, 'opencode');
    mkdirSync(existing, { recursive: true });
    const sentinel = path.join(existing, 'existing-owned-state.json');
    const bytes = Buffer.from('{"preserve":"existing SDK state"}\n');
    writeFileSync(sentinel, bytes);
    const before = statSync(env.CLAUDE_MULTIMODEL_DATA_HOME);
    const repeated = sandboxEnvironment(root, path.join(root, 'opencode.cmd'));
    const after = statSync(repeated.CLAUDE_MULTIMODEL_DATA_HOME);
    assert.equal(repeated.CLAUDE_MULTIMODEL_DATA_HOME, env.CLAUDE_MULTIMODEL_DATA_HOME);
    assert.deepEqual(readFileSync(sentinel), bytes, 'Existing data must never be deleted or replaced');
    for (const key of ['dev', 'ino', 'mode', 'uid', 'gid']) {
      assert.equal(after[key], before[key], 'Existing data ' + key + ' must remain unchanged');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const ancestor of ['with spaces', 'Юникод 世界']) {
  test(`backfill case path preserves an ASCII owned suffix under a canonical ${ancestor} ancestor`, () => {
    const parent = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'backfill-case-path-')));
    try {
      const root = path.join(parent, ancestor);
      const binary = path.join(root, 'ascii', 'bin', 'runtime.exe');
      mkdirSync(path.dirname(binary), { recursive: true });
      writeFileSync(binary, 'fixture-only');
      const physicalRoot = realpathSync.native(root);
      const physicalBinary = realpathSync.native(binary);
      assert.equal(path.relative(physicalRoot, physicalBinary), path.join('ascii', 'bin', 'runtime.exe'));
      assert.doesNotThrow(() => assertBackfillCasePath(physicalRoot, 'ascii', physicalBinary));
      for (const invalid of ['ascii with spaces', 'ascii-世界']) {
        assert.throws(() => assertBackfillCasePath(physicalRoot, 'ascii', path.join(physicalRoot, invalid, 'bin', 'runtime.exe')),
          /ASCII case/);
      }
      assert.throws(() => assertBackfillCasePath(physicalRoot, 'ascii', path.join(parent, 'foreign', 'runtime.exe')),
        /owned smoke root/);
      for (const shape of ['with spaces', 'Юникод 世界', 'Юникод 世界 cmd']) {
        assert.doesNotThrow(() => assertBackfillCasePath(physicalRoot, shape, path.join(physicalRoot, shape, 'bin', 'runtime.exe')));
      }
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
}

test('runtime relocation preserves packaged Bun and executable physical graph across every path shape', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-relocation-'));
  try {
    const source = path.join(root, 'source');
    const modules = path.join(source, 'local-cli/node_modules/fixture-package');
    mkdirSync(modules, { recursive: true });
    mkdirSync(path.join(source, 'bun'));
    mkdirSync(path.join(source, 'cursor-managed'));
    const executable = Buffer.from('compiled-frontdoor-fixture');
    const bundledBun = Buffer.from('pinned-bun-fixture');
    writeFileSync(path.join(source, 'cli.exe'), executable);
    writeFileSync(path.join(source, 'bun/bun.exe'), bundledBun);
    writeFileSync(path.join(source, 'cursor-managed/asset.txt'), 'managed-asset');
    writeFileSync(path.join(modules, 'index.cjs'), 'module.exports = "physical-dependency";');
    writeFileSync(path.join(source, 'local-cli/cli.js'), `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      assert.equal(fs.readFileSync(path.join(__dirname, '../bun/bun.exe'), 'utf8'), 'pinned-bun-fixture');
      console.log(require('./node_modules/fixture-package/index.cjs'));
    `);
    for (const shape of ['ascii', 'with spaces', 'Юникод 世界', 'Юникод 世界 cmd']) {
      const target = path.join(root, shape, 'bin');
      mkdirSync(target, { recursive: true });
      const binary = stageRuntimeDelivery(path.join(source, 'cli.exe'), target);
      assert.deepEqual(readFileSync(binary), executable);
      assert.deepEqual(readFileSync(path.join(target, 'bun/bun.exe')), bundledBun);
      assert.equal(readFileSync(path.join(target, 'cursor-managed/asset.txt'), 'utf8'), 'managed-asset');
      // Execute the relocated physical graph with Node; actual Windows front-door
      // and hash verification remain covered by the existing executable smoke.
      const result = spawnSync(process.execPath, [path.join(target, 'local-cli/cli.js')], {
        cwd: target, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'physical-dependency');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime relocation preserves legacy standalone compiled delivery', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-relocation-legacy-'));
  try {
    const source = path.join(root, 'source'), target = path.join(root, 'target');
    mkdirSync(source); mkdirSync(target);
    writeFileSync(path.join(source, 'cli.exe'), 'standalone-frontdoor');
    const binary = stageRuntimeDelivery(path.join(source, 'cli.exe'), target);
    assert.equal(readFileSync(binary, 'utf8'), 'standalone-frontdoor');
    assert.equal(existsSync(path.join(target, 'bun')), false);
    assert.equal(existsSync(path.join(target, 'local-cli')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime relocation refuses a partial packaged delivery before copying an executable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-relocation-partial-'));
  try {
    for (const present of ['bun', 'local-cli']) {
      const source = path.join(root, present, 'source'), target = path.join(root, present, 'target');
      mkdirSync(path.join(source, present), { recursive: true }); mkdirSync(target);
      writeFileSync(path.join(source, 'cli.exe'), 'compiled-frontdoor');
      assert.throws(() => stageRuntimeDelivery(path.join(source, 'cli.exe'), target), /requires both bun and local-cli/);
      assert.equal(existsSync(path.join(target, 'runtime.exe')), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cleanup script inventory covers known fixtures without admitting dependency graph scripts', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cleanup-inventory-'));
  try {
    const expected = ['', 'ascii', 'with spaces', 'Юникод 世界', 'Юникод 世界 cmd']
      .map(directory => path.join(root, directory, 'fake-opencode.cjs'));
    for (const script of expected) {
      mkdirSync(path.dirname(script), { recursive: true }); writeFileSync(script, '// owned fixture');
    }
    const foreign = path.join(root, 'ascii/bin/local-cli/node_modules/foreign/fake-opencode.cjs');
    mkdirSync(path.dirname(foreign), { recursive: true }); writeFileSync(foreign, '// dependency script');
    assert.deepEqual(fixtureScriptPaths(root), expected);
    assert.equal(fixtureScriptPaths(root).includes(foreign), false);
    assert.ok(fixtureScriptPaths(root).every(script => existsSync(script)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


// Real SQLite reader + attribution/reconstruction using preinstalled dependencies,
// without loading the full CLI, compiling, starting a provider, or modifying a project.
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
      const { OpenCodeSessionStore } = await import(${JSON.stringify(path.join(repository, 'src/services/opencode/OpenCodeSessionStore.ts'))});
      const record = await new OpenCodeSessionStore(${JSON.stringify(path.join(env.CLAUDE_MULTIMODEL_DATA_HOME, 'opencode/session-store.json'))}).get(fixture.body.teamName, 'secondary:opencode:bob', 'bob');
      assert.ok(record, 'Fixture must resolve through the production session store');
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
    assert.equal(options.timeout, WINDOWS_BACKFILL_TEARDOWN_TIMEOUT_MS);
    assert.equal(WINDOWS_BACKFILL_TEARDOWN_TIMEOUT_MS, 3 * 60_000);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    // Check emitted diagnostic boundaries; native execution remains Windows-only.
    const command = argv.at(-1);
    for (const [phase, operation] of [
      ...['Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility']
        .map(name => [`import ${name}`, `Import-Module ${name} -ErrorAction Stop`]),
      ['load System.Management', "[void][System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')"],
      ['script enumeration', '$scripts = @(foreach ($candidate in $fixtureScriptCandidates)'],
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
      assert.equal(report.teardown.timeoutMs, WINDOWS_BACKFILL_TEARDOWN_TIMEOUT_MS);
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

// CLI envelopes are injected here; the launch resolver runs unchanged in Bun.
// This covers standalone fixture wiring, not native Windows or bundled app MCP.
test('provider smoke canonicalizes owned temp roots before child cwd and controlled environment paths', t => {
  const parent = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'provider-canonical-temp-')));
  const physicalTemp = path.join(parent, 'physical');
  const aliasTemp = path.join(parent, 'alias');
  mkdirSync(physicalTemp);
  symlinkSync(physicalTemp, aliasTemp, process.platform === 'win32' ? 'junction' : 'dir');
  const report = { cases: [] };
  const launches = [];
  let fixtureRoot, physicalRoot;
  try {
    t.mock.method(os, 'tmpdir', () => aliasTemp);
    runProviderSmoke('/fixture/runtime.exe', report, () => {}, {
      spawn: (_executable, argv, { env, cwd }) => {
        const input = argv.includes('--input')
          ? JSON.parse(readFileSync(argv[argv.indexOf('--input') + 1], 'utf8')) : null;
        launches.push({ env, cwd, argv, input });
        const payload = !input
          ? { runtimeId: 'opencode', view: { providers: [{ providerId: 'opencode' }] } }
          : { command: input.command, requestId: input.requestId,
            ok: input.command === 'opencode.handshake', data: { hostHealthy: true } };
        const stdout = JSON.stringify(payload);
        if (argv.includes('--output')) writeFileSync(argv[argv.indexOf('--output') + 1], stdout);
        return { status: 0, signal: null, stdout, stderr: '' };
      },
      cleanup: (group, root) => {
        fixtureRoot = root;
        physicalRoot = realpathSync.native(root);
        finishSmokeCleanup(group, root, { teardown: () => {} });
      },
    });
    assert.equal(report.error, undefined);
    assert.equal(report.cleanupError, undefined);
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.deepEqual(report.cases.map(item => item.label),
      ['providers-view', 'handshake-file', 'handshake-stdout', 'readiness-stdout']);
    assert.equal(launches.length, 4);
    assert.equal(existsSync(fixtureRoot), false, 'Owned fixture must be removed after the checks');
    const assertCanonical = (value, label) => {
      const relative = path.relative(physicalRoot, value);
      assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `${label} must remain inside the physical owned root`);
      assert.equal(value, path.join(physicalRoot, relative), `${label} must use the physical canonical path`);
    };
    for (const [index, launch] of launches.entries()) {
      assertCanonical(launch.cwd, `spawn ${index} cwd`);
      for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR',
        'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR',
        'CLAUDE_MULTIMODEL_DATA_HOME', 'CLAUDE_MULTIMODEL_CACHE_HOME', 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH',
        'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY', 'GIT_CONFIG_GLOBAL']) {
        assertCanonical(launch.env[key], `spawn ${index} ${key}`);
      }
      for (const flag of ['--project-path', '--input', '--output']) {
        if (launch.argv.includes(flag)) assertCanonical(launch.argv[launch.argv.indexOf(flag) + 1], `spawn ${index} ${flag}`);
      }
      if (launch.input) assert.equal(launch.input.cwd, launch.cwd);
      if (launch.input?.command === 'opencode.readiness') {
        assert.equal(launch.input.body.projectPath, launch.cwd);
        assert.equal(launch.input.body.requireExecutionProbe, false);
      }
    }
  } finally {
    t.mock.restoreAll();
    rmSync(parent, { recursive: true, force: true });
  }
});

test('provider fixture supplies an isolated MCP entry to the production resolver', { timeout: 15000 }, () => {
  const report = { cases: [] };
  const environments = [];
  let fixtureRoot;
  const bun = existingBun();
  assert.ok(bun, 'Existing Bun required; never install dependencies for this test');
  runProviderSmoke('/fixture/runtime.exe', report, () => {}, {
    spawn: (_executable, argv, { env, cwd }) => {
      environments.push(env);
      const input = argv.includes('--input')
        ? JSON.parse(readFileSync(argv[argv.indexOf('--input') + 1], 'utf8')) : null;
      if (input?.command === 'opencode.readiness') {
        assert.equal(input.body.requireExecutionProbe, false);
        assert.equal(input.body.projectPath, cwd);
      }
      const payload = !input
        ? { runtimeId: 'opencode', view: { providers: [{ providerId: 'opencode' }] } }
        : { command: input.command, requestId: input.requestId,
          ok: input.command === 'opencode.handshake', data: { hostHealthy: true } };
      const stdout = JSON.stringify(payload);
      if (argv.includes('--output')) writeFileSync(argv[argv.indexOf('--output') + 1], stdout);
      return { status: 0, stdout, stderr: '' };
    },
    cleanup: (_group, root) => {
      fixtureRoot = root;
      try {
        assert.equal(environments.length, 4);
        const env = environments[0];
        const entry = env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY;
        assert.equal(typeof entry, 'string', 'Standalone provider smoke needs an explicit fixture MCP entry');
        assert.equal(path.isAbsolute(entry), true);
        assert.equal(path.dirname(entry), root);
        assert.equal(statSync(entry).isFile(), true);
        assert.ok(environments.every(item => item === env));
        for (const key of ['CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND',
          'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL']) {
          assert.equal(env[key], undefined, 'Fixture must not use an inherited MCP override');
        }
        const resolver = fileURLToPath(new URL('../../src/services/opencode/OpenCodeMcpManager.ts', import.meta.url));
        const program = `
          import assert from 'node:assert/strict';
          const { resolveOpenCodeAppMcpLaunchConfig } = await import(${JSON.stringify(resolver)});
          const resolved = await resolveOpenCodeAppMcpLaunchConfig({
            pathExists: async () => { throw new Error('Fixture must not discover a sibling app'); },
          });
          assert.equal(resolved.source, 'env-override');
          assert.equal(resolved.config.type, 'local');
          assert.deepEqual(resolved.config.command, [Bun.which('node'), process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY]);
          assert.equal(resolved.config.enabled, true);
          const withoutEntry = { ...process.env };
          delete withoutEntry.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY;
          await assert.rejects(resolveOpenCodeAppMcpLaunchConfig({ env: withoutEntry, pathExists: async () => false }),
            /Unable to resolve the agent-teams MCP entrypoint/);
        `;
        const result = spawnSync(bun, ['--eval', program], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr + result.stdout);
        // A mistaken attempt to execute this placeholder must fail visibly.
        const executed = spawnSync(process.execPath, [entry], { cwd: root, env, encoding: 'utf8', timeout: 1000 });
        assert.ifError(executed.error);
        assert.equal(executed.status, 1);
        assert.match(executed.stderr, /fixture only/);
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  });
  assert.equal(report.error, undefined);
  assert.ok(report.cases.every(item => item.passed), JSON.stringify(report));
  assert.equal(existsSync(fixtureRoot), false);
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
  // Acceptance must remain uninstrumented: stream listeners and native exit
  // callback wrappers can perturb the very transport race under investigation.
  const program = attempt === 1 ? `
    console.error(JSON.stringify({ phase: 'before-production-import', attempt: 1, bunVersion: Bun.version }));
    const { readProcessStartTimeMs } = await import(${JSON.stringify(pathToFileURL(processKill).href)});
    console.error(JSON.stringify({ phase: 'before-production-query', attempt: 1, bunVersion: Bun.version }));
    const started = performance.now();
    const startedAtMs = await readProcessStartTimeMs(${pid});
    console.error(JSON.stringify({ phase: 'after-production-query', attempt: 1, elapsedMs: performance.now() - started, startedAtMs }));
    console.log(JSON.stringify({ startedAtMs }));
  ` : `
    const { traceProductionIdentity } = await import(${JSON.stringify(identityProbeModule)});
    await traceProductionIdentity(${JSON.stringify({ processKill: pathToFileURL(processKill).href, pid, attempt })});
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

function identityProbeMarkers(probe) {
  return probe?.stderr?.trim().split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) ?? [];
}

// This separate traced check runs only AFTER ordinary first-call acceptance.
// Its result can verify that no helper was spawned, never rescue the first call.
function assertNativeIdentityRepeat(probe, firstIdentity) {
  assert.ok(!probe.error && probe.status === 0, 'Native identity repeat must exit successfully');
  const markers = identityProbeMarkers(probe);
  const completion = markers.find(item => item.phase === 'after-production-query');
  assert.ok(completion && Number.isFinite(completion.startedAtMs), 'Native identity repeat must complete');
  assert.equal(JSON.parse(probe.stdout).startedAtMs, completion.startedAtMs);
  assert.ok(Number.isFinite(firstIdentity), 'Only first production identity can satisfy acceptance');
  assert.equal(completion.startedAtMs, firstIdentity);
  assert.equal(markers.filter(item => ['query-child', 'query-native'].includes(item.phase)
    && item.event === 'invocation').length, 0, 'Native Windows identity must not spawn a helper');
}

function diagnoseWindowsStartup(evidence, flush, env, root, bun) {
  const traced = evidence.probes.find(item => item.label === 'production-identity-repeat-1');
  const markers = identityProbeMarkers(traced);
  const completion = markers.find(item => item.phase === 'after-production-query');
  assert.ok(!traced?.error && traced?.status === 0 && completion,
    'Diagnostic production query must finish before interpreting child traces');
  const invocations = markers.filter(item => item.phase === 'query-child' && item.event === 'invocation');
  if (invocations.length === 0) {
    assert.equal(markers.filter(item => item.phase === 'query-native' && item.event === 'invocation').length, 0,
      'No-child diagnostic must not hide a native child invocation');
    evidence.identityDiagnostics = { kind: 'no-child-query', startedAtMs: completion.startedAtMs };
    flush();
    return;
  }
  assert.equal(invocations.length, 1, 'Must capture the actual traced production invocation');
  const invocation = invocations[0];
  // Change one transport variable at a time. The first two production attempts
  // already cover Bun with ignored stdin/stderr, with and without observers.
  // Node now gets IDENTICAL argv
  // and async stdio instead of a different script through spawnSync.
  for (const [label, executable, mode] of [
    ['node-exact-production-query', process.execPath, 'exact'],
    ['bun-production-query-stderr-pipe', bun, 'stderr-pipe'],
    ['bun-production-query-stdin-eof', bun, 'stdin-eof'],
  ]) {
    const program = `
      const { replayIdentityQuery } = await import(${JSON.stringify(identityProbeModule)});
      await replayIdentityQuery(${JSON.stringify({ invocation, mode })});
    `;
    recordWindowsProbe(evidence, flush, label, executable, ['--input-type=module', '--eval', program],
      { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 7000 });
  }
}

test('native repeat proves completion and first identity without a child invocation', () => {
  const identity = 1_792_513_777_348;
  const probe = { status: 0, error: null, stdout: JSON.stringify({ startedAtMs: identity }),
    stderr: JSON.stringify({ phase: 'after-production-query', startedAtMs: identity }) };
  assert.doesNotThrow(() => assertNativeIdentityRepeat(probe, identity));
  for (const rejected of [
    { ...probe, status: 1 },
    { ...probe, error: { code: 'ETIMEDOUT' } },
    { ...probe, stderr: '' },
    { ...probe, stdout: JSON.stringify({ startedAtMs: identity + 1 }) },
    { ...probe, stderr: JSON.stringify({ phase: 'after-production-query', startedAtMs: null }) },
    ...['query-child', 'query-native'].map(phase => ({ ...probe,
      stderr: probe.stderr + '\n' + JSON.stringify({ phase, event: 'invocation' }) })),
  ]) assert.throws(() => assertNativeIdentityRepeat(rejected, identity));
  assert.throws(() => assertNativeIdentityRepeat(probe, undefined));
  assert.throws(() => assertNativeIdentityRepeat(probe, identity + 1));
});

test('completed no-child diagnostics preserve first failure without inventing a PowerShell replay', t => {
  const spawn = t.mock.method(childProcess, 'spawnSync', () => { throw new Error('No child to replay'); });
  syncBuiltinESMExports();
  try {
    const probe = { label: 'production-identity-repeat-1', status: 0, error: null,
      stderr: JSON.stringify({ phase: 'after-production-query', startedAtMs: null }) };
    const evidence = { probes: [probe], error: 'original first identity failure' };
    let flushes = 0;
    diagnoseWindowsStartup(evidence, () => { flushes++; }, {}, '/isolated', '/existing/bun');
    assert.deepEqual(evidence.identityDiagnostics, { kind: 'no-child-query', startedAtMs: null });
    assert.equal(evidence.startedAtMs, undefined);
    assert.equal(evidence.error, 'original first identity failure');
    assert.equal(evidence.probes.length, 1);
    assert.equal(flushes, 1);
    assert.equal(spawn.mock.callCount(), 0);
    for (const stderr of ['',
      probe.stderr + '\n' + JSON.stringify({ phase: 'query-native', event: 'invocation' }),
      probe.stderr + '\n' + [1, 2].map(() => JSON.stringify({ phase: 'query-child', event: 'invocation' })).join('\n'),
    ]) {
      assert.throws(() => diagnoseWindowsStartup({ probes: [{ ...probe, stderr }] }, () => {}, {}, '/isolated', '/existing/bun'));
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

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

test('identity tracing preserves transport and kill, bounds data, and distinguishes exit from close', () => {
  const events = [];
  const kills = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: null,
    pid: 123, exitCode: null, signalCode: null,
    kill: signal => { kills.push(signal); return false; },
  });
  const args = ['-Command', 'exact production command'];
  const options = { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    env: { ONLY_SANDBOX: 'do not emit environment values' } };
  const spawn = traceSpawn((command, receivedArgs, receivedOptions) => {
    assert.equal(command, 'powershell.exe');
    assert.equal(receivedArgs, args);
    assert.equal(receivedOptions, options);
    return child;
  }, item => events.push(item));
  assert.equal(spawn('powershell.exe', args, options), child);
  child.stdout.write('x'.repeat(3000));
  child.stdout.write('discarded');
  child.emit('exit', 0, null);
  assert.equal(events.some(item => item.event === 'close'), false);
  assert.equal(child.kill('SIGKILL'), false);
  child.emit('close', 0, null);
  assert.deepEqual(kills, ['SIGKILL']);
  assert.deepEqual(events.filter(item => ['exit', 'kill-request', 'close'].includes(item.event))
    .map(item => item.event), ['exit', 'kill-request', 'close']);
  assert.equal(events.filter(item => item.event === 'stdout-data').map(item => item.text).join('').length, 2048);
  assert.equal(events[0].envExplicit, true);
  assert.deepEqual(events[0].environmentKeys, ['ONLY_SANDBOX']);
  assert.equal(JSON.stringify(events).includes(options.env.ONLY_SANDBOX), false);
  assert.deepEqual(environmentSummary({ b: '2', a: '1' }), environmentSummary({ a: '1', b: '2' }));
  assert.notEqual(environmentSummary({ a: '1' }).environmentHash, environmentSummary({ a: '2' }).environmentHash);
});

test('exact transport replays keep nonzero exit, expose ignored versus piped stderr, and send stdin EOF', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'identity-transport-'));
  try {
    const env = sandboxEnvironment(root, path.join(root, 'unused.cmd'));
    for (const runtime of [process.execPath, existingBun()]) {
      assert.ok(runtime);
      for (const mode of ['exact', 'stderr-pipe', 'stdin-eof']) {
        const childProgram = `
          process.stdin.resume();
          process.stdin.on('end', () => {
            process.stderr.write('query stderr');
            process.stdout.write('2026-09-09T03:26:43.6163024Z');
            process.exitCode = 7;
          });
        `;
        const invocation = { command: process.execPath, args: ['--eval', childProgram],
          options: { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }, envExplicit: false };
        const program = `
          const { replayIdentityQuery, environmentSummary } = await import(${JSON.stringify(identityProbeModule)});
          // Windows may add identity variables while creating this process.
          console.error(JSON.stringify({ phase: 'environment-before-replay', ...environmentSummary(process.env) }));
          await replayIdentityQuery(${JSON.stringify({ invocation, mode, timeoutMs: 1500 })});
        `;
        const probe = recordWindowsProbe({ probes: [] }, () => {}, mode, runtime,
          ['--input-type=module', '--eval', program], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
        assert.equal(probe.status, 0, probe.stderr);
        const result = JSON.parse(probe.stdout);
        assert.equal(result.code, 7, probe.stderr);
        assert.equal(result.timedOut, false);
        const events = probe.stderr.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(events.some(item => item.event === 'stderr-data'), mode === 'stderr-pipe');
        assert.equal(events.some(item => item.event === 'stdin-finish'), mode === 'stdin-eof');
        assert.ok(events.some(item => item.event === 'stdout-end'));
        assert.ok(events.some(item => item.event === 'exit' && item.code === 7));
        assert.ok(events.some(item => item.event === 'close' && item.code === 7));
        const before = events.find(item => item.phase === 'environment-before-replay');
        const spawned = events.find(item => item.event === 'invocation');
        assert.deepEqual(spawned.args, invocation.args);
        assert.deepEqual(spawned.environmentKeys, before.environmentKeys);
        assert.equal(spawned.environmentHash, before.environmentHash);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('transport timeout cannot turn partial identity output into success', () => {
  const invocation = { command: process.execPath,
    args: ['--eval', "process.stdout.write('2026-09-09T03:26:43.6163024Z'); setInterval(() => {}, 1000)"],
    options: { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }, envExplicit: false };
  const program = `
    const { replayIdentityQuery } = await import(${JSON.stringify(identityProbeModule)});
    await replayIdentityQuery(${JSON.stringify({ invocation, mode: 'exact', timeoutMs: 500 })});
  `;
  const probe = recordWindowsProbe({ probes: [] }, () => {}, 'hung', process.execPath,
    ['--input-type=module', '--eval', program], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000 });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.equal(result.timedOut, true);
  assert.ok(result.output.includes('2026-09-09'));
  assert.equal(result.code, undefined);
  assert.match(probe.stderr, /kill-request/);
});

test('Bun production tracing observes the actual helper spawn, close, and deadline', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'identity-production-trace-'));
  try {
    const env = sandboxEnvironment(root, path.join(root, 'unused.cmd'));
    for (const hung of [false, true]) {
      // Exercise the real Windows branch and its real timer through Bun. Only
      // the OS child is substituted on Linux; this is not native PowerShell proof.
      const childProgram = `process.stdout.write('2026-09-09T03:26:43.6163024Z'); ${hung ? 'setInterval(() => {}, 1000)' : ''}`;
      const program = `
        import cp from 'node:child_process';
        const spawn = cp.ChildProcess.prototype.spawn;
        cp.ChildProcess.prototype.spawn = function(options) {
          return spawn.call(this, { ...options, file: ${JSON.stringify(process.execPath)},
            args: [${JSON.stringify(process.execPath)}, '--eval', ${JSON.stringify(childProgram)}] });
        };
        const { traceProductionIdentity } = await import(${JSON.stringify(identityProbeModule)});
        await traceProductionIdentity(${JSON.stringify({ processKill: pathToFileURL(path.join(repository, 'src/utils/processKill.ts')).href,
          pid: 2104, attempt: 1, powerShellOnly: true })});
      `;
      const probe = recordWindowsProbe({ probes: [] }, () => {}, 'synthetic-production-child', existingBun(),
        ['--eval', program], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 });
      assert.equal(probe.status, 0, probe.stderr);
      const value = JSON.parse(probe.stdout).startedAtMs;
      assert.equal(value, hung ? null : Date.parse('2026-09-09T03:26:43.6163024Z'), probe.stderr);
      const events = probe.stderr.trim().split('\n').map(line => JSON.parse(line));
      const invocation = events.find(item => item.event === 'invocation');
      assert.equal(invocation.command, 'powershell.exe');
      assert.deepEqual(invocation.options, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      assert.equal(invocation.envExplicit, false);
      assert.match(invocation.args[5], /GetProcessById\(2104\)/);
      assert.equal(invocation.environmentHash, environmentSummary(env).environmentHash);
      const native = events.find(item => item.phase === 'query-native' && item.event === 'invocation');
      assert.deepEqual(native.command, [process.execPath, '--eval', childProgram]);
      // Bun's node adapter maps "ignore" to null before Bun.spawn.
      assert.deepEqual(native.stdio, [null, 'pipe', 'pipe']);
      assert.equal(native.environmentHash, invocation.environmentHash);
      assert.ok(events.some(item => item.event === 'stdout-data'));
      const after = events.find(item => item.phase === 'after-production-query');
      if (hung) {
        assert.ok(after.elapsedMs >= 4900, JSON.stringify(after));
        assert.ok(events.some(item => item.event === 'kill-request' && item.args[0] === 'SIGKILL'));
      } else {
        assert.ok(events.some(item => item.phase === 'query-native' && item.event === 'exit' && item.code === 0));
        assert.ok(events.some(item => item.event === 'close' && item.code === 0));
        assert.equal(events.some(item => item.event === 'kill-request'), false);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Linux wiring only: do not warm PowerShell before the native Windows first query.
test('first production acceptance has no child observers; only the diagnostic repeat is traced', t => {
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', (executable, args, options) => {
    calls.push({ executable, args, options });
    return { status: 0, signal: null, stdout: '{"startedAtMs":null}\n', stderr: '' };
  });
  syncBuiltinESMExports();
  try {
    const evidence = { probes: [] };
    const env = { HOME: '/isolated', PATH: '/trusted' };
    for (const attempt of [1, 2]) productionIdentityProbe(evidence, () => {}, '/existing/bun', env, '/isolated', 2104, attempt);
    assert.match(calls[0].args[1], /await readProcessStartTimeMs\(2104\)/);
    assert.doesNotMatch(calls[0].args[1], /identity-probe|traceProductionIdentity|ChildProcess|Bun\.spawn/);
    assert.match(calls[1].args[1], /traceProductionIdentity/);
    for (const call of calls) {
      assert.equal(call.options.env, env);
      assert.equal(call.options.timeout, 10000);
      assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    }
    assert.equal(evidence.startedAtMs, undefined);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

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
// no 30s identity retry. Production itself has a 5s PowerShell query deadline.
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
      // keeps the production 5s query deadline and existing 10s Bun outer bound.
      ['diagnostic-production-repeat-1', () => {
        const probe = productionIdentityProbe(evidence, flush, bun, env, root, children[0]?.pid, 2);
        if (process.arch === 'x64') assertNativeIdentityRepeat(probe, evidence.startedAtMs);
      }],
      ['diagnostic-startup-controls', () => {
        if (!Number.isFinite(evidence.startedAtMs) && children[0]?.pid) {
          diagnoseWindowsStartup(evidence, flush, env, root, bun);
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

// Run real redirected Windows PowerShell after the first cold identity query.
// The ASCII control reproduces the old producer's literal '?' bytes; the fixed
// body must retain exact Unicode on both streams while doing the same teardown.
test('Windows teardown preserves exact Unicode stdout and stderr with BOM-less UTF-8', {
  skip: process.platform !== 'win32', timeout: 90000,
}, async t => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'TEST-teardown Юникод 世界-')));
  const env = sandboxEnvironment(root, path.join(root, 'opencode.cmd'));
  const script = path.join(root, 'fake-opencode.cjs');
  const unrelatedScript = script + ' unrelated-helper.cjs';
  const children = [];
  const runs = [];
  const utf8Assignment = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)';
  const unicodeBytes = Buffer.from('Юникод 世界', 'utf8');
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const start = async file => {
    writeFileSync(file, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);");
    const child = spawn(process.execPath, [file], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await Promise.all([once(child, 'spawn'), once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) })]);
    return child;
  };
  try {
    const unrelated = await start(unrelatedScript);
    for (const variant of ['fixed-utf8', 'legacy-ascii']) {
      const child = await start(script);
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(35000) });
      exited.catch(() => {});
      const emitted = buildWindowsTeardownCommand(root, [child.pid]);
      let body = emitted;
      if (variant === 'legacy-ascii') {
        assert.equal(emitted.split(utf8Assignment).length, 2, 'One explicit output encoding assignment required');
        body = emitted.replace(utf8Assignment, '');
      }
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        "[Console]::OutputEncoding = [System.Text.Encoding]::ASCII\n" + body], {
        cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
        windowsHide: true, maxBuffer: 1024 * 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr?.toString('utf8'));
      assert.equal(result.signal, null);
      const stdout = result.stdout.toString('utf8');
      const stderr = result.stderr.toString('utf8');
      for (const [name, bytes, text] of [['stdout', result.stdout, stdout], ['stderr', result.stderr, stderr]]) {
        assert.deepEqual(Buffer.from(text, 'utf8'), bytes, name + ' must be valid UTF-8 bytes');
        assert.equal(bytes.subarray(0, bom.length).equals(bom), false, name + ' must not have a UTF-8 BOM');
      }
      const stopped = JSON.parse(stdout);
      assert.equal(stopped.length, 1);
      assert.equal(stopped[0].pid, child.pid);
      assert.ok(Number.isFinite(Date.parse(stopped[0].startedAt)));
      const groups = stopped[0].commandLine.match(windowsNodeScriptPattern)?.groups;
      const emittedScript = groups?.quotedScript || groups?.bareScript;
      const diagnostic = stderr.split(/\r?\n/).find(line => line.startsWith('teardown: fixture ownership '));
      const ownership = JSON.parse(diagnostic?.slice('teardown: fixture ownership '.length));
      assert.equal(ownership.pid, child.pid);
      assert.equal(ownership.owned, true);
      assert.match(stderr, new RegExp('teardown: after identity validation pid=' + child.pid));
      assert.match(stderr, new RegExp('teardown: after wait for exit pid=' + child.pid));
      assert.match(stderr, /teardown: after JSON output/);
      const exact = variant === 'fixed-utf8';
      assert.equal(result.stdout.includes(unicodeBytes), exact, variant + ' raw stdout Unicode');
      assert.equal(result.stderr.includes(unicodeBytes), exact, variant + ' raw stderr Unicode');
      assert.equal(ownership.script, emittedScript, variant + ' stdout/stderr script agreement');
      if (exact) {
        assert.equal(emittedScript, script, 'Fixed JSON must retain the exact whole script path');
        assert.equal(realpathSync.native(stopped[0].executable).toLowerCase(), realpathSync.native(process.execPath).toLowerCase());
      } else {
        assert.notEqual(emittedScript, script, 'Legacy producer must reproduce the real Unicode identity failure');
        const corruptedTail = path.join(path.basename(root).replace('Юникод 世界', '?????? ??'), 'fake-opencode.cjs');
        assert.ok(emittedScript.endsWith(corruptedTail), 'Legacy producer must emit literal ASCII replacement bytes in the known owned suffix');
      }
      await exited;
      assert.equal(process.kill(unrelated.pid, 0), true, 'Shared-prefix unowned fixture must survive each teardown');
      assert.equal(process.kill(process.pid, 0), true, 'Parent must survive each teardown');
      runs.push({ variant, status: result.status, ownedPid: child.pid, stdoutUnicodeExact: exact,
        stderrUnicodeExact: exact, stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length });
    }
  } finally {
    const cleanup = await Promise.allSettled(children.map(async child => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
        exited.catch(() => {});
        child.kill(); // Only this test's own ChildProcess handle, including its negative fixture.
        await exited;
      }
    }));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    t.diagnostic(JSON.stringify({ unicodeTeardownRuns: runs }));
    assert.deepEqual(cleanup.filter(item => item.status === 'rejected'), [], 'Direct test-child cleanup must succeed');
  }
});

// Keep this PowerShell contract after the first native production identity test;
// it must not warm that test's cold helper query.
test('Windows cleanup admits exact fixtures without recursively inspecting portable graphs', {
  skip: process.platform !== 'win32', timeout: 25000,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cleanup inventory 世界-'));
  try {
    const scripts = fixtureScriptPaths(root);
    for (const script of scripts) {
      mkdirSync(path.dirname(script), { recursive: true }); writeFileSync(script, '// owned fixture');
    }
    const foreign = path.join(root, 'ascii/bin/local-cli/node_modules/foreign/fake-opencode.cjs');
    mkdirSync(path.dirname(foreign), { recursive: true }); writeFileSync(foreign, '// dependency script');
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    const cases = [...scripts.map(script => [true, script]),
      [false, foreign], [false, path.join(root + '-sibling', 'fake-opencode.cjs')]];
    const marker = "[Console]::Error.WriteLine('teardown: before script enumeration')";
    const prefix = buildWindowsTeardownCommand(root).split('$stopped = @()')[0];
    // A copied dependency graph may be arbitrarily large or unreadable. Force
    // any directory walk to fail, while actual direct file checks remain live.
    const guarded = prefix.replace(marker,
      "function Get-ChildItem { throw 'Unexpected fixture directory traversal' }\n" + marker);
    const command = guarded + `
      $cases = ConvertFrom-Json ${literal(JSON.stringify(cases))}
      foreach ($case in $cases) {
        $entry = [pscustomobject]@{ ExecutablePath = $nodePath; CommandLine = ('"' + $nodePath + '" "' + $case[1] + '"') }
        if ([bool](Is-Owned $entry) -ne $case[0]) { throw 'Fixed fixture inventory ownership mismatch' }
      }
      if ($scripts.Count -ne 5) { throw 'Known fixture inventory is incomplete' }
      ConvertTo-Json -InputObject @{ cases = $cases.Count; scripts = $scripts.Count } -Compress
    `;
    const invoke = body => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body], {
      cwd: root, env: sandboxEnvironment(root, path.join(root, 'opencode.cmd')),
      encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 64 * 1024,
    });
    // Execute the original selector under the same traversal guard: it must
    // fail, rather than silently widening or skipping script ownership.
    const start = guarded.indexOf('$scripts = @(');
    const end = guarded.indexOf("[Console]::Error.WriteLine('teardown: after script enumeration");
    assert.ok(start >= 0 && end > start);
    const oldSelector = '$scripts = @(Get-ChildItem -LiteralPath $rootPath -Filter fake-opencode.cjs -Recurse -File | ForEach-Object { Get-OwnershipPath $_.FullName })\n';
    const old = invoke(guarded.slice(0, start) + oldSelector + guarded.slice(end));
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /Unexpected fixture directory traversal/);
    const result = invoke(command);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { cases: 7, scripts: 5 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
