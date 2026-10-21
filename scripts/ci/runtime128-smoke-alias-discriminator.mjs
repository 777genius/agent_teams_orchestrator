#!/usr/bin/env node
// Diagnostic only: one native alias/canonical pair, then one complete corrected smoke.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'e1892ddd32230736c29469d5347a1b659cd49945';
const [deliveryArg, smokeEntryArg, evidenceArg] = process.argv.slice(2);
assert(deliveryArg && smokeEntryArg && evidenceArg && process.argv.length === 5,
  'Expected delivery root, corrected smoke entry, and fresh absolute TEST evidence directory');
assert(path.isAbsolute(evidenceArg) && path.basename(evidenceArg).startsWith('TEST-'), 'Fresh TEST evidence directory required');
mkdirSync(evidenceArg); // Never adopt an existing evidence directory.
const evidence = realpathSync.native(evidenceArg);
const reportPath = path.join(evidence, 'alias-discriminator.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { schemaVersion: 1, diagnosticOnly: true, qualification: false, passed: false,
  sourceCommit: SOURCE, runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  startedAt: new Date().toISOString(), controllerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
  platform: process.platform, arch: process.arch, nodeVersion: process.version, runs: [], fixtureRemoved: false };
const flush = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
writeFileSync(path.join(evidence, 'controller.mjs.txt'), readFileSync(fileURLToPath(import.meta.url)));
flush();

function physical(file, owned) {
  const resolved = realpathSync.native(file), relative = path.relative(owned, resolved);
  assert(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Delivery file escaped physical root');
  const info = lstatSync(resolved);
  assert(info.isFile() && !info.isSymbolicLink(), 'Physical regular file required');
  return resolved;
}
function pin(file) { const bytes = readFileSync(file); return { path: file, bytes: bytes.length, sha256: sha(bytes) }; }
const samePath = (left, right) => path.win32.relative(left, right) === '';
function directoryIdentity(directory) {
  const value = statSync(directory, { bigint: true });
  assert(value.isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Owned directory required');
  assert(value.ino > 0n && value.dev >= 0n, 'Nonzero OS file identity required');
  return { dev: String(value.dev), ino: String(value.ino) };
}
function plumbing() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(systemroot|windir|comspec|pathext|systemdrive)$/i.test(key)) env[key] = value;
  }
  assert(Object.keys(env).some(key => /^systemroot$/i.test(key)), 'Windows system root required');
  return env;
}
const errorInfo = error => ({ name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null,
  message: String(error?.message ?? error).slice(0, 2000) });

// Timeout/overflow cleanup is a failure even if a synthetic close later reports zero.
async function run(label, executable, argv, cwd, env, input, timeoutMs, outputLimit) {
  const item = { label, executable, argv, cwd, envKeys: Object.keys(env).sort(),
    envSha256: sha(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))),
    timeoutMs, outputLimitBytesPerStream: outputLimit, startedAt: new Date().toISOString(),
    pid: null, code: null, signal: null, timedOut: false, overflow: false, cleanupRequested: false,
    spawnError: null, stdinError: null, closeObserved: false, naturalClose: false };
  report.runs.push(item); flush();
  const outFile = path.join(evidence, `${label}.stdout.log`), errFile = path.join(evidence, `${label}.stderr.log`);
  writeFileSync(outFile, ''); writeFileSync(errFile, '');
  const started = performance.now();
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), child, timer, grace, settled = false;
  const closed = new Promise(resolve => {
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); resolve(); };
    const abort = reason => {
      if (reason === 'timeout') item.timedOut = true;
      else if (reason === 'overflow') item.overflow = true;
      if (item.cleanupRequested) return;
      item.cleanupRequested = true;
      try { child.kill('SIGKILL'); } catch (error) { item.cleanupError = errorInfo(error); }
      grace = setTimeout(() => {
        item.closeGraceExpired = true;
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish();
      }, 3000);
    };
    child = spawn(executable, argv, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    item.pid = child.pid ?? null;
    child.on('error', error => { item.spawnError = errorInfo(error); });
    child.stdin.on('error', error => { item.stdinError = errorInfo(error); });
    const capture = (stream, chunk) => {
      const previous = stream === 'stdout' ? stdout : stderr;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const kept = bytes.subarray(0, Math.max(0, outputLimit - previous.length));
      try { appendFileSync(stream === 'stdout' ? outFile : errFile, kept); }
      catch (error) { item.recordingError = errorInfo(error); abort('recording-error'); return; }
      if (stream === 'stdout') stdout = Buffer.concat([stdout, kept]); else stderr = Buffer.concat([stderr, kept]);
      if (previous.length + bytes.length > outputLimit) abort('overflow');
    };
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    child.once('close', (code, signal) => { item.code = code; item.signal = signal; item.closeObserved = true; finish(); });
    timer = setTimeout(() => abort('timeout'), timeoutMs);
    child.stdin.end(input ?? '');
  });
  await closed;
  Object.assign(item, { elapsedMs: Math.round(performance.now() - started),
    stdoutBytes: stdout.length, stderrBytes: stderr.length, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) });
  item.naturalClose = item.closeObserved && !item.cleanupRequested && !item.spawnError && !item.stdinError;
  if (label.startsWith('native-')) {
    item.stdout = stdout.toString('utf8'); item.stderr = stderr.toString('utf8');
    try {
      const rows = item.stdout.trim().split(/\r?\n/).filter(Boolean);
      assert.equal(rows.length, 1, 'One native reply required');
      item.reply = JSON.parse(rows[0]);
    } catch (error) { item.replyError = errorInfo(error); }
  }
  flush();
  assert(item.naturalClose && item.code === 0 && item.signal === null, `${label}: natural zero close required`);
  return item;
}

let fixture, fixtureIdentity, files, harnessFiles;
try {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  assert.match(process.version, /^v24\./);
  assert.equal(process.env.BACKFILL_RUNTIME_SOURCE_COMMIT, SOURCE);
  assert.match(process.env.BACKFILL_RUNTIME_HARNESS_COMMIT ?? '', /^[a-f0-9]{40}$/);
  assert.match(process.env.BACKFILL_RUNTIME_BUN_VERSION ?? '', /^1\.4\.2(?:\+[^\s]+)?$/);
  report.harnessCommit = process.env.BACKFILL_RUNTIME_HARNESS_COMMIT;
  report.buildBunVersion = process.env.BACKFILL_RUNTIME_BUN_VERSION;
  const delivery = realpathSync.native(deliveryArg), smokeEntry = realpathSync.native(smokeEntryArg);
  assert.equal(path.basename(smokeEntry), 'windows-runtime-opencode-provider-json.mjs');
  files = {
    frontDoor: physical(path.join(delivery, 'cli.exe'), delivery),
    shippedBun: physical(path.join(delivery, 'bun/bun.exe'), delivery),
    localEntry: physical(path.join(delivery, 'local-cli/cli.js'), delivery),
    deliveryIdentity: physical(path.join(delivery, 'opencode-delivery.json'), delivery),
    nativeHelper: physical(path.join(delivery, 'local-cli/native/win32-x64/opencode-v2-windows-helper.exe'), delivery),
    helperProducerManifest: physical(path.join(delivery, 'local-cli/native/win32-x64/windows-helper.json'), delivery),
  };
  harnessFiles = { entry: smokeEntry,
    backfill: realpathSync.native(path.join(path.dirname(smokeEntry), 'windows-runtime-opencode-backfill.mjs')),
    fixture: realpathSync.native(path.join(path.dirname(smokeEntry), 'windows-runtime-opencode-fixture.cjs')) };
  report.deliveryBefore = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, pin(file)]));
  report.harnessBefore = Object.fromEntries(Object.entries(harnessFiles).map(([name, file]) => [name, pin(file)]));
  const identity = JSON.parse(readFileSync(files.deliveryIdentity, 'utf8'));
  assert.equal(identity.schema, 1); assert.equal(identity.platform, 'win32'); assert.equal(identity.arch, 'x64');
  assert.equal(identity.bunVersion, '1.4.3');
  assert.equal(identity.bunSha256, report.deliveryBefore.shippedBun.sha256);
  assert.equal(identity.entrySha256, report.deliveryBefore.localEntry.sha256);
  const producer = JSON.parse(readFileSync(files.helperProducerManifest, 'utf8'));
  assert.equal(producer.format, 1); assert.equal(producer.platform, 'win32'); assert.equal(producer.arch, 'x64');
  assert.equal(producer.name, 'opencode-v2-windows-helper.exe');
  assert.equal(producer.sha256, report.deliveryBefore.nativeHelper.sha256);
  report.deliveryIdentity = identity; report.helperProducer = producer; flush();

  const rawFixture = mkdtempSync(path.join(os.tmpdir(), 'TEST-runtime128-smoke-alias-'));
  fixture = realpathSync.native(rawFixture); fixtureIdentity = directoryIdentity(fixture);
  const rawLocal = path.join(rawFixture, 'localappdata'); mkdirSync(rawLocal);
  const canonicalLocal = realpathSync.native(rawLocal);
  assert(!samePath(rawLocal, canonicalLocal) && /~[0-9]+(?:\\|$)/i.test(rawLocal), 'Actual 8.3 spelling must differ; stop rather than fabricate a pair');
  assert(samePath(realpathSync.native(rawLocal), canonicalLocal), 'Alias and canonical path must resolve identically');
  assert.deepEqual(directoryIdentity(rawLocal), directoryIdentity(canonicalLocal));
  report.fixture = { raw: rawFixture, canonical: fixture, identity: fixtureIdentity,
    rawLocalAppData: rawLocal, canonicalLocalAppData: canonicalLocal, localAppDataIdentity: directoryIdentity(canonicalLocal) };
  const helperEnv = plumbing(), helperArgs = ['--self-image-custody', producer.sha256];
  const input = JSON.stringify({ schema: 1, id: 1, operation: 'selfImageCustody', input: {} }) + '\n';
  const red = await run('native-alias', files.nativeHelper, helperArgs, fixture,
    { ...helperEnv, LOCALAPPDATA: rawLocal }, input, 15000, 64 * 1024);
  assert.equal(red.stderr, ''); assert(!red.replyError);
  assert.equal(red.reply.schema, 1); assert.equal(red.reply.kind, 'reply'); assert.equal(red.reply.id, 1);
  assert.equal(red.reply.ok, false); assert.equal(red.reply.error, 'execution_path_alias');
  assert.equal(red.reply.stage, 'alias_predicate'); assert.equal(red.reply.nativeCode, 0);
  assert.deepEqual(red.reply.alias, { operation: 'selfImageCustody', sourceLine: 355, predicates: 4 });
  assert.deepEqual(directoryIdentity(rawLocal), report.fixture.localAppDataIdentity);
  const green = await run('native-canonical', files.nativeHelper, helperArgs, fixture,
    { ...helperEnv, LOCALAPPDATA: canonicalLocal }, input, 15000, 64 * 1024);
  assert.equal(green.stderr, ''); assert(!green.replyError);
  assert.equal(green.reply.schema, 1); assert.equal(green.reply.kind, 'reply'); assert.equal(green.reply.id, 1);
  assert.equal(green.reply.ok, true);
  const selected = path.join(canonicalLocal, 'AgentTeams.OpenCodeV2.Native', producer.sha256, producer.name);
  assert.equal(green.reply.value.sourcePath, files.nativeHelper); assert.equal(green.reply.value.path, selected);
  assert.equal(green.reply.value.sha256, producer.sha256);
  assert.equal(green.reply.value.privateAcl, true); assert.equal(green.reply.value.protectedDacl, true);
  assert.equal(sha(readFileSync(selected)), producer.sha256);
  assert.deepEqual(directoryIdentity(rawLocal), report.fixture.localAppDataIdentity);
  report.sameDirectoryAliasPredicateProven = true; flush();

  const rawSmokeTemp = path.join(rawFixture, 'smoke-tmp'); mkdirSync(rawSmokeTemp);
  const fullEnv = { ...plumbing(), TMP: rawSmokeTemp, TEMP: rawSmokeTemp, TMPDIR: rawSmokeTemp,
    BACKFILL_RUNTIME_SOURCE_COMMIT: SOURCE, BACKFILL_RUNTIME_HARNESS_COMMIT: report.harnessCommit,
    BACKFILL_RUNTIME_BUN_VERSION: report.buildBunVersion };
  const smokeReceipt = path.join(evidence, 'backfill-runtime-evidence.json');
  await run('corrected-full-smoke', process.execPath, [smokeEntry, files.frontDoor, smokeReceipt],
    fixture, fullEnv, '', 20 * 60 * 1000, 1024 * 1024);
  const receiptBytes = readFileSync(smokeReceipt); assert(receiptBytes.length <= 4 * 1024 * 1024);
  const smoke = JSON.parse(receiptBytes);
  assert.equal(smoke.schemaVersion, 2); assert.equal(smoke.platform, 'win32'); assert.equal(smoke.arch, 'x64');
  assert.equal(smoke.sourceCommit, SOURCE); assert.equal(smoke.harnessCommit, report.harnessCommit);
  assert.equal(smoke.executableSha256, report.deliveryBefore.frontDoor.sha256); assert.equal(smoke.passed, true);
  assert.deepEqual(Object.keys(smoke.groups).sort(), ['backfill', 'provider']);
  for (const group of Object.values(smoke.groups)) {
    assert.equal(group.passed, true); assert(!group.error && !group.cleanupError && !group.remainingRoot);
    assert.equal(group.teardown.status, 0); assert.equal(group.teardown.signal, null); assert(!group.teardown.error);
    assert.deepEqual(JSON.parse(group.teardown.stdout), []);
  }
  const backfill = smoke.groups.backfill;
  assert.deepEqual(backfill.cases.map(row => [row.shape, row.transport]),
    [['ascii', 'direct'], ['with spaces', 'direct'], ['Юникод 世界', 'direct'], ['Юникод 世界 cmd', 'app-exe-fallback']]);
  for (const row of backfill.cases) {
    assert(row.passed && !row.error && !row.controlError);
    assert.equal(row.executableSha256, report.deliveryBefore.frontDoor.sha256);
    assert.deepEqual(row.invocations.map(item => item.label), ['control', 'empty', 'import', 'replay']);
    for (const item of row.invocations) {
      assert.equal(item.status, 0); assert.equal(item.signal, null); assert(!item.error);
      const payload = JSON.parse(item.output); assert.equal(payload.ok, true);
      if (item.label !== 'control') {
        assert.equal(payload.data.outcome, { empty: 'no-history', import: 'imported', replay: 'duplicates-only' }[item.label]);
        assert.equal(payload.data.importedEvents, item.label === 'import' ? 1 : 0);
      }
    }
    assert(row.probeInvocations.trim().split('\n').some(line => JSON.parse(line).argv.slice(2).includes('--version')));
  }
  const provider = smoke.groups.provider;
  assert.deepEqual(provider.mcpEvidence, { mode: 'simulated-opencode-http-attach', bundledAppMcp: false, executableTools: false });
  assert.deepEqual(provider.cases.map(row => row.label), ['providers-view', 'handshake-file', 'handshake-stdout', 'readiness-stdout']);
  for (const row of provider.cases) {
    assert(row.passed && !row.error); assert.equal(row.status, 0); assert.equal(row.signal, null);
  }
  report.fullSmoke = { receiptBytes: receiptBytes.length, receiptSha256: sha(receiptBytes),
    backfillCases: 4, backfillInvocations: 16, providerChecks: 4, passed: true,
    scope: 'Synthetic OpenCode HTTP/backfill regression; not actual provider, bundled app MCP, or inference qualification.' };
  report.deliveryAfter = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, pin(file)]));
  report.harnessAfter = Object.fromEntries(Object.entries(harnessFiles).map(([name, file]) => [name, pin(file)]));
  assert.deepEqual(report.deliveryAfter, report.deliveryBefore); assert.deepEqual(report.harnessAfter, report.harnessBefore);
  report.deliveryAnchorsUnchanged = true; report.harnessAnchorsUnchanged = true;
  assert.deepEqual(report.runs.map(row => row.label), ['native-alias', 'native-canonical', 'corrected-full-smoke']);
  assert(report.runs.every(row => row.naturalClose && row.code === 0 && row.signal === null));
  assert(samePath(realpathSync.native(fixture), fixture)); assert.deepEqual(directoryIdentity(fixture), fixtureIdentity);
  rmSync(fixture, { recursive: true, force: false, maxRetries: 5, retryDelay: 250 });
  report.fixtureRemoved = true; report.passed = true;
} catch (error) {
  report.failure = errorInfo(error);
  report.fixtureRetained = fixture ? existsSync(fixture) : null;
  process.exitCode = 1;
} finally {
  if (files && !report.deliveryAfter) {
    try { report.deliveryAfter = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, pin(file)])); }
    catch (error) { report.finalPinError = errorInfo(error); }
  }
  report.completedAt = new Date().toISOString(); flush();
  console.log(JSON.stringify({ passed: report.passed, report: reportPath, fixtureRemoved: report.fixtureRemoved }));
}
