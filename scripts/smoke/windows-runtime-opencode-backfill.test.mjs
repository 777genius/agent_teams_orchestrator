import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { assertBackfillEnvelope, assertImportedLedger, createBackfillFixture, finishSmokeCleanup, runSmokeGroups, sandboxEnvironment, teardownOwnedProcesses, trustedSearchPath } from './windows-runtime-opencode-backfill.mjs';

import { assertReadinessHost, runProviderSmoke, runRecordedCheck } from './windows-runtime-opencode-provider-json.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');

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
    const bun = (process.env.PATH || '').split(path.delimiter)
      .map(dir => path.join(dir, process.platform === 'win32' ? 'bun.exe' : 'bun'))
      .find(candidate => existsSync(candidate));
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

test('Windows isolated PATH captures identity and teardown stops only the owned fixture', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'backfill-owned-process-'));
  const script = path.join(root, 'fake-opencode.cjs');
  writeFileSync(script, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);");
  const unrelatedScript = path.join(root, 'unrelated-helper.cjs');
  writeFileSync(unrelatedScript, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);");
  const env = sandboxEnvironment(root, path.join(root, 'opencode.cmd'));
  const child = spawn(process.execPath, [script], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const unrelated = spawn(process.execPath, [unrelatedScript], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.all([once(child.stdout, 'data'), once(unrelated.stdout, 'data')]);
    const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; (Get-Process -Id ${child.pid}).StartTime.ToUniversalTime().ToString('o')`],
    { env, cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(query.status, 0, JSON.stringify({
      status: query.status, signal: query.signal, error: query.error?.message,
      stdout: query.stdout, stderr: query.stderr,
    }));
    assert.ok(Number.isFinite(Date.parse(query.stdout.trim())));
    const report = {};
    const exited = once(child, 'exit');
    teardownOwnedProcesses(root, report, env);
    await exited;
    const stopped = JSON.parse(report.teardown.stdout);
    assert.ok(stopped.some(entry => entry.pid === child.pid));
    assert.ok(stopped.every(entry => entry.pid !== process.pid && entry.pid !== unrelated.pid));
    assert.equal(process.kill(process.pid, 0), true, 'parent Node remains alive');
    assert.equal(process.kill(unrelated.pid, 0), true, 'Node running another script remains alive');
  } finally {
    for (const processHandle of [child, unrelated]) {
      if (processHandle.exitCode === null && processHandle.signalCode === null) {
        const exited = once(processHandle, 'exit');
        processHandle.kill();
        await exited;
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});
