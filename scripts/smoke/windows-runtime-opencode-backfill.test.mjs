import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertBackfillEnvelope, assertImportedLedger, createBackfillFixture, sandboxEnvironment } from './windows-runtime-opencode-backfill.mjs';

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
