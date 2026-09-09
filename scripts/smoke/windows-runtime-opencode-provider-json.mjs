#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBackfillSmoke, sandboxEnvironment } from './windows-runtime-opencode-backfill.mjs';

const runtimeBinary = path.resolve(process.argv[2] || path.join('dist', 'cli.exe'));
runBackfillSmoke(runtimeBinary, process.argv[3]);
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-teams-runtime-opencode-smoke-'));
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
  '@echo off\r\nnode "%~dp0fake-opencode.cjs" %*\r\n',
  'utf8',
);

const smokeEnv = sandboxEnvironment(tempRoot, fakeOpenCodeCmd);

function runRuntime(args, options = {}) {
  const result = spawnSync(runtimeBinary, args, {
    cwd: projectPath,
    env: smokeEnv,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 45_000,
    windowsHide: true,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
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

try {
  const providersResult = runRuntime([
    'runtime',
    'providers',
    'view',
    '--runtime',
    'opencode',
    '--json',
    '--compact',
    '--project-path',
    projectPath,
  ]);
  assertExitZero(providersResult, 'runtime providers view');
  const providersPayload = assertJsonObject(providersResult.stdout, 'runtime providers view', providersResult);
  if (providersPayload.runtimeId !== 'opencode') {
    throw new Error('runtime providers view returned the wrong runtimeId');
  }
  const providers = providersPayload.view?.providers;
  if (!Array.isArray(providers) || !providers.some(provider => provider?.providerId === 'opencode')) {
    throw new Error('runtime providers view did not include the fake OpenCode provider');
  }

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

  const bridgeResult = runRuntime([
    'runtime',
    'opencode-command',
    '--json',
    '--input',
    bridgeInputPath,
    '--output',
    bridgeOutputPath,
  ]);
  assertExitZero(bridgeResult, 'runtime opencode-command');
  const bridgePayload = assertJsonObject(readFileSync(bridgeOutputPath, 'utf8'), 'runtime opencode-command');
  if (bridgePayload.ok !== true || bridgePayload.command !== 'opencode.handshake') {
    throw new Error('runtime opencode-command did not return a successful handshake envelope');
  }

  const bridgeStdoutResult = runRuntime([
    'runtime',
    'opencode-command',
    '--json',
    '--input',
    bridgeInputPath,
  ]);
  assertExitZero(bridgeStdoutResult, 'runtime opencode-command stdout');
  const bridgeStdoutPayload = assertJsonObject(
    bridgeStdoutResult.stdout,
    'runtime opencode-command stdout',
    bridgeStdoutResult,
  );
  if (bridgeStdoutPayload.ok !== true || bridgeStdoutPayload.command !== 'opencode.handshake') {
    throw new Error('runtime opencode-command stdout did not return a successful handshake envelope');
  }

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

  const readinessStdoutResult = runRuntime([
    'runtime',
    'opencode-command',
    '--json',
    '--input',
    readinessInputPath,
  ]);
  assertExitZero(readinessStdoutResult, 'runtime opencode-command readiness stdout');
  const readinessStdoutPayload = assertJsonObject(
    readinessStdoutResult.stdout,
    'runtime opencode-command readiness stdout',
    readinessStdoutResult,
  );
  if (
    readinessStdoutPayload.command !== 'opencode.readiness' ||
    typeof readinessStdoutPayload.ok !== 'boolean'
  ) {
    throw new Error('runtime opencode-command readiness stdout did not return a bridge envelope');
  }

  process.stdout.write('Windows runtime OpenCode provider JSON smoke passed\n');
} finally {
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  } catch {
    // Best effort only. Windows can keep the fake host process alive briefly.
  }
}
