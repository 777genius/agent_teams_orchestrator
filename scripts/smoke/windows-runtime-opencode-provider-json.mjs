#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { finishSmokeCleanup, runBackfillSmoke, runSmokeGroups, sandboxEnvironment } from './windows-runtime-opencode-backfill.mjs';

const actualProvider = 'deepinfra', actualModel = 'TEST-local-catalog-model';
export function actualProviderResult(payload, operation, binaryPath, exitCode = 0) {
  const diagnostics = operation === 'view' ? payload?.view?.diagnostics : payload?.models?.diagnostics;
  const pending = Array.isArray(diagnostics) && diagnostics.some(value => typeof value === 'string' && value.includes('capabilities_pending'));
  const identityUnavailable = typeof payload?.error?.message === 'string' && /Selected OpenCode identity (?:is )?unavailable/.test(payload.error.message);
  const view = payload?.view, models = payload?.models;
  const passed = exitCode === 0 && payload?.runtimeId === 'opencode' && !payload.error && !pending && (operation === 'view'
    ? view?.runtime?.cliPath === binaryPath && view.runtime.version === '1.18.31' &&
      view.providers?.some(value => value.providerId === actualProvider && value.state === 'connected')
    : models?.providerId === actualProvider && models.catalogState === 'fresh' &&
      models.models?.some(value => value.providerId === actualProvider && value.modelId === actualModel));
  return { passed: passed === true, capabilitiesPending: pending, identityUnavailable,
    errorCode: ['runtime-unhealthy', 'runtime-missing', 'provider-missing'].find(code => code === payload?.error?.code) ?? null };
}

export function catalogGuard(request, response, observations) {
  const allowed = request.method === 'GET' && ['/models', '/v1/models', '/auth'].includes(request.url);
  if (observations.length < 64) observations.push({ allowed });
  else observations.overflow = true;
  request.resume();
  response.writeHead(allowed ? 200 : 405, { 'content-type': 'application/json' });
  response.end(JSON.stringify(allowed ? { object: 'list', data: [{ id: actualModel, object: 'model' }] } : { error: 'TEST inference forbidden' }));
}

/** Genuine npm V1 + released/candidate SDK comparison; no fake OpenCode server.
 * Existing CLI commands prepare their own managed profiles. Only TEST config and
 * a noncredential are supplied. No session/prompt/test-model operation is invoked. */
export async function runActualProviderComparison(baseline, candidate, binaryPath, evidencePath, aclHelper) {
  assert.equal(process.platform, 'win32');
  for (const value of [baseline, candidate, binaryPath, evidencePath, aclHelper]) assert.ok(path.isAbsolute(value));
  assert.equal(path.basename(aclHelper), 'opencode-native-test-auth.ts');
  assert.match(evidencePath, /(?:^|[\\/])TEST-[^\\/]+(?:[\\/]|$)/);
  assert.equal(path.basename(binaryPath).toLowerCase(), 'opencode.cmd');
  const npmRoot = path.join(path.dirname(binaryPath), '..', 'opencode-ai');
  const npmPackage = JSON.parse(readFileSync(path.join(npmRoot, 'package.json'), 'utf8'));
  assert.equal(npmPackage.name, 'opencode-ai'); assert.equal(npmPackage.version, '1.18.31');
  const observations = [], server = createServer((req, res) => catalogGuard(req, res, observations));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'TEST-real-opencode-provider-')));
  const report = { schemaVersion: 1, scope: 'actual npm V1 metadata only; no inference', root,
    nativeVersion: '1.18.31', npmShimSha256: createHash('sha256').update(readFileSync(binaryPath)).digest('hex'),
    runs: [], providerRequests: observations, passed: false };
  const flush = () => writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
  const execute = promisify(execFile);
  try {
    // Reuse the desktop's existing TEST-only DACL producer, rather than weaken
    // native ownership checks or introduce another directory ACL implementation.
    const { protectWindowsTestDirectory } = await import(pathToFileURL(aclHelper).href);
    await protectWindowsTestDirectory(root);
    for (const [label, runtime] of [['baseline118', baseline], ['candidate119', candidate]]) {
      const owned = path.join(root, label); mkdirSync(owned);
      const env = sandboxEnvironment(owned, binaryPath), project = path.join(owned, 'project'); mkdirSync(project);
      await protectWindowsTestDirectory(env.CLAUDE_MULTIMODEL_DATA_HOME);
      env.DEEPINFRA_API_KEY = 'TEST-only-no-real-credential';
      Object.assign(env, { OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1' });
      const config = { plugin: [], provider: { [actualProvider]: {
        options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '{env:DEEPINFRA_API_KEY}' },
        models: { [actualModel]: { name: 'TEST catalog model', limit: { context: 8192, output: 1024 } } },
      } } };
      const configRoot = path.join(env.HOME, '.config', 'opencode'); mkdirSync(configRoot, { recursive: true });
      writeFileSync(path.join(configRoot, 'opencode.jsonc'), JSON.stringify(config));
      const run = { label, runtimeSha256: createHash('sha256').update(readFileSync(runtime)).digest('hex'),
        configSha256: createHash('sha256').update(JSON.stringify(config)).digest('hex'), checks: [], cleanupConfirmed: false };
      report.runs.push(run); flush();
      try {
        for (const operation of ['view', 'models']) {
          const argv = ['runtime', 'providers', operation, '--runtime', 'opencode', '--json', '--project-path', project,
            ...(operation === 'view' ? ['--compact'] : ['--provider', actualProvider])];
          let payload, exitCode = 0;
          try { const result = await execute(runtime, argv, { cwd: project, env, timeout: 45000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
            payload = JSON.parse(result.stdout.trim()); } catch (error) {
            exitCode = Number.isInteger(error.code) ? error.code : null;
            // Public provider errors intentionally exit1 with a JSON envelope.
            // Project its fixed classification, never retain raw output/body.
            try { payload = JSON.parse(error.stdout.trim()); } catch { /* Invalid output remains unavailable. */ }
          }
          run.checks.push({ operation, exitCode, ...actualProviderResult(payload, operation, binaryPath, exitCode) }); flush();
        }
      } catch { run.setupFailed = true; }
      finally {
        const input = path.join(owned, 'cleanup.json');
        writeFileSync(input, JSON.stringify({ schemaVersion: 1, requestId: 'TEST-provider-cleanup',
          command: 'opencode.cleanupStartupHosts', cwd: project, startedAt: new Date().toISOString(), timeoutMs: 20000,
          body: { mode: 'force', projectPath: project, reason: 'TEST-provider-comparison', deadlineUnixMs: Date.now() + 20000 } }));
        try { const result = await execute(runtime, ['runtime', 'opencode-command', '--json', '--input', input],
          { cwd: project, env, timeout: 45000, windowsHide: true, maxBuffer: 1024 * 1024 });
          const payload = JSON.parse(result.stdout.trim());
          run.cleanupConfirmed = payload.ok === true && payload.data?.remaining === 0 && payload.data?.startupCleanup?.completion === 'drained';
        } catch { /* Unknown cleanup stays false; retain the exact TEST root. */ }
        flush();
      }
    }
    report.baselineReproduced = report.runs[0].checks.some(check => check.capabilitiesPending) &&
      report.runs[0].checks.some(check => check.identityUnavailable);
    report.providerRequestOverflow = observations.overflow === true;
    report.passed = report.runs[1].checks.length === 2 && report.runs[1].checks.every(check => check.passed) &&
      report.runs.every(run => run.checks.length === 2 && run.cleanupConfirmed) && !observations.overflow && observations.every(row => row.allowed);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); flush();
  }
  assert.equal(report.passed, true, 'Actual provider comparison failed; preserve finite receipt and TEST roots');
  return report;
}

// Record before launch and before assertions: failures retain exact transport evidence.
export function runRecordedCheck(group, label, invocation, validate, { spawn = spawnSync, flush = () => {} } = {}) {
  const { env, ...transport } = invocation;
  const item = { label, ...transport, passed: false };
  group.cases.push(item);
  flush();
  try {
    const result = spawn(item.executable, item.argv, { cwd: item.cwd, env,
      encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 45000, windowsHide: true, shell: false });
    Object.assign(item, { pid: result.pid, status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
    if (item.outputPath && existsSync(item.outputPath)) item.output = readFileSync(item.outputPath, 'utf8');
    flush();
    if (result.error) throw result.error;
    assertExitZero(result, label);
    validate(item.outputPath ? item.output : item.stdout, result);
    item.passed = true;
  } catch (error) { item.error = error.stack || String(error); }
  finally { flush(); }
  return item;
}

export function assertReadinessHost(payload) {
  assert.equal(payload.command, 'opencode.readiness');
  assert.equal(typeof payload.ok, 'boolean');
  // The simulated HTTP MCP attach must succeed: an absent /mcp entry makes
  // readiness fail with hostHealthy:false. Host startup must also capture a
  // non-null process identity in the unchanged production OpenCodeHostManager.
  assert.equal(payload.data?.hostHealthy, true, JSON.stringify(payload));
}

function describeRuntimeResult(result) {
  if (!result) {
    return '';
  }
  return ` status=${result.status} signal=${result.signal ?? 'null'} stdout=${JSON.stringify((result.stdout ?? '').slice(0, 1000))} stderr=${JSON.stringify((result.stderr ?? '').slice(0, 1000))}`;
}

function assertJsonObject(raw, label, result) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} returned empty stdout.${describeRuntimeResult(result)}`);
  }
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} did not return a JSON object`);
  }
  return parsed;
}

function assertExitZero(result, label) {
  if (result.status !== 0) {
    throw new Error(
      `${label} exited with ${result.status}. stdout=${JSON.stringify(result.stdout.slice(0, 500))} stderr=${JSON.stringify(result.stderr.slice(0, 500))}`,
    );
  }
}


export function runProviderSmoke(runtimeBinary, report, flush, { spawn = spawnSync, cleanup = finishSmokeCleanup } = {}) {
  report.mcpEvidence = { mode: 'simulated-opencode-http-attach', bundledAppMcp: false, executableTools: false };
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-teams-runtime-opencode-smoke-'));
  try {
    const fakeOpenCodeScript = path.join(tempRoot, 'fake-opencode.cjs');
    const fakeOpenCodeCmd = path.join(tempRoot, 'opencode.cmd');
    const projectPath = path.join(tempRoot, 'project with spaces');
    mkdirSync(projectPath, { recursive: true });

    writeFileSync(
      fakeOpenCodeScript,
      readFileSync(new URL('./windows-runtime-opencode-fixture.cjs', import.meta.url), 'utf8'),
      'utf8',
    );

    writeFileSync(
      fakeOpenCodeCmd,
      `@echo off\r\nSET "_prog=${process.execPath}"\r\n"%_prog%" "%~dp0fake-opencode.cjs" %*\r\n`,
      'utf8',
    );

    const smokeEnv = sandboxEnvironment(tempRoot, fakeOpenCodeCmd);
    // Standalone CI has no sibling app MCP bundle. The fake OpenCode server
    // accepts a local attach and retains its simulated status/config over HTTP;
    // it never executes MCP commands or tools. This entry resolves the profile
    // but deliberately fails direct MCP tools/list. This is host/identity smoke,
    // not bundled app MCP or launch readiness evidence.
    const fixtureMcpEntry = path.join(tempRoot, 'fixture-agent-teams-mcp.cjs');
    writeFileSync(fixtureMcpEntry,
      'throw new Error("Windows provider smoke fixture only: not an MCP server");\n', 'utf8');
    smokeEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = fixtureMcpEntry;

    const check = (label, argv, validate, outputPath) => runRecordedCheck(report, label,
      { executable: runtimeBinary, argv, cwd: projectPath, env: smokeEnv, outputPath },
      (raw, result) => validate(assertJsonObject(raw || '', label, result)), { spawn, flush });

    check('providers-view', [
      'runtime', 'providers', 'view', '--runtime', 'opencode', '--json', '--compact', '--project-path', projectPath,
    ], payload => {
      assert.equal(payload.runtimeId, 'opencode');
      assert.ok(payload.view?.providers?.some(provider => provider?.providerId === 'opencode'),
        'runtime providers view did not include the fake OpenCode provider');
    });

    const bridgeInputPath = path.join(tempRoot, 'opencode-handshake.json');
    const bridgeOutputPath = path.join(tempRoot, 'opencode-handshake.output.json');
    writeFileSync(
      bridgeInputPath,
      JSON.stringify({
        schemaVersion: 1,
        requestId: 'runtime-opencode-smoke',
        command: 'opencode.handshake',
        cwd: projectPath,
        startedAt: new Date().toISOString(),
        timeoutMs: 45_000,
        body: {
          client: {
            schemaVersion: 1,
            peer: 'claude_team',
            appVersion: 'smoke',
            gitSha: null,
            buildId: null,
            bridgeProtocol: {
              minVersion: 1,
              currentVersion: 1,
              supportedCommands: [
                'opencode.handshake',
                'opencode.commandStatus',
                'opencode.readiness',
              ],
              opencodeTaskLedgerEvidenceContractVersion: 1,
              opencodeAppManagedBootstrapContractVersion: 1,
              opencodeDeliveryAcceptanceContractVersion: 2,
            },
            runtime: {
              providerId: 'opencode',
              binaryPath: null,
              binaryFingerprint: null,
              version: null,
              capabilitySnapshotId: null,
              runtimeStoreManifestHighWatermark: null,
              activeRunId: null,
            },
            featureFlags: {
              opencodeTeamLaunch: true,
              opencodeStateChangingCommands: true,
            },
          },
          requiredCommand: 'opencode.readiness',
          expectedRunId: null,
          expectedCapabilitySnapshotId: null,
          expectedManifestHighWatermark: 0,
        },
      }, null, 2),
      'utf8',
    );

    const assertHandshake = payload => {
      assert.equal(payload.ok, true);
      assert.equal(payload.command, 'opencode.handshake');
      assert.equal(payload.requestId, 'runtime-opencode-smoke');
    };
    check('handshake-file', ['runtime', 'opencode-command', '--json', '--input', bridgeInputPath, '--output', bridgeOutputPath],
      assertHandshake, bridgeOutputPath);
    check('handshake-stdout', ['runtime', 'opencode-command', '--json', '--input', bridgeInputPath], assertHandshake);

    const readinessInputPath = path.join(tempRoot, 'opencode-readiness.json');
    writeFileSync(
      readinessInputPath,
      JSON.stringify({
        schemaVersion: 1,
        requestId: 'runtime-opencode-readiness-smoke',
        command: 'opencode.readiness',
        cwd: projectPath,
        startedAt: new Date().toISOString(),
        timeoutMs: 45_000,
        body: {
          projectPath,
          selectedModel: 'opencode/big-pickle',
          requireExecutionProbe: false,
        },
      }, null, 2),
      'utf8',
    );

    check('readiness-stdout', ['runtime', 'opencode-command', '--json', '--input', readinessInputPath], assertReadinessHost);
  } catch (error) { report.error = error.stack || String(error); }
  finally {
    try {
      const log = path.join(tempRoot, 'fake-opencode-invocations.jsonl');
      if (existsSync(log)) report.probeInvocations = readFileSync(log, 'utf8');
    } catch (error) { report.error = error.stack || String(error); }
    cleanup(report, tempRoot);
    flush();
  }
  return report;
}

export function runCombinedSmoke(binaryInput, evidenceInput) {
  const runtimeBinary = path.resolve(binaryInput);
  const evidencePath = path.resolve(evidenceInput || 'backfill-runtime-evidence.json');
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  const report = { schemaVersion: 2, platform: process.platform, arch: process.arch,
    nodeVersion: process.version, parentPid: process.pid, runtimeBinary,
    sourceCommit: process.env.BACKFILL_RUNTIME_SOURCE_COMMIT,
    harnessCommit: process.env.BACKFILL_RUNTIME_HARNESS_COMMIT,
    buildBunVersion: process.env.BACKFILL_RUNTIME_BUN_VERSION, passed: false };
  const flush = () => writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
  flush();
  assert.equal(process.platform, 'win32', 'Packaged Windows coverage requires actual Windows execution');
  report.executableSha256 = createHash('sha256').update(readFileSync(runtimeBinary)).digest('hex');
  runSmokeGroups(report, {
    backfill: (group, save) => runBackfillSmoke(runtimeBinary, evidencePath, { report: group, flush: save }),
    provider: (group, save) => runProviderSmoke(runtimeBinary, group, save),
  }, flush);
  assert.equal(report.passed, true, `Packaged Windows smoke failed; combined evidence: ${evidencePath}`);
  process.stdout.write('Windows runtime OpenCode backfill and provider JSON smoke passed\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--actual-provider-compare') {
    assert.equal(process.argv.length, 8);
    await runActualProviderComparison(...process.argv.slice(3));
  } else runCombinedSmoke(process.argv[2] || path.join('dist', 'cli.exe'), process.argv[3]);
}
