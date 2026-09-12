#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const ROOT_ARTIFACT = 'Productcff8868d093b4e899a6307850eb8b8841a87df62';
const PROVENANCE_SHA256 = '3f284264827255e7ee356fa199765c128f367fc758f1a14808dd79647d6cb24e';
const NATIVE_SHA256 = 'f892701ed9dfdedf1d6e966a1e05a93e952202ab636ae1bf8053bea0b121cbe0';
const SANDBOX_PREFIX = 'owner-built-anchor-smoke-';
const REPORT_NAME = 'built-anchor-smoke-evidence.json';
const NODE24_PATH = '/usr/local/bin/node';
const OUTPUT_LIMIT = 64 * 1024;
const SUPERVISOR_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 30_000;
const PORTABLE_O_CLOEXEC = constants.O_CLOEXEC ?? 0;

const PROVIDER_PROGRAM = String.raw`
if (!process.versions.node.startsWith('24.')) {
  process.stderr.write('wrong-node-major:' + process.versions.node + '\n');
  process.exit(72);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (input) => {
  process.stdout.write('stdout:' + input + '|node:' + process.versions.node + '\n');
  process.stderr.write('stderr:' + input + '|node:' + process.versions.node + '\n');
});
setInterval(() => {}, 1000);
`;

const MARKER_PROGRAM = String.raw`
process.stdout.write('MARKER_READY\n');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

class InMemoryExactStore {
  state;
  async load(scope) {
    if (!this.state) return { status: 'missing' };
    return exactScope(this.state.intent.scope, scope) ? { status: 'found', state: this.state } : { status: 'missing' };
  }
  async loadByProcessRef(processRef) {
    return this.state?.intent.processRef === processRef ? { status: 'found', state: this.state } : { status: 'missing' };
  }
  async compareAndSwap(request) {
    const actualRevision = this.state?.revision ?? null;
    if (actualRevision !== request.expectedRevision) return { status: 'conflict' };
    if (this.state && !exactScope(this.state.intent.scope, request.scope)) return { status: 'conflict' };
    this.state = request.next;
    return { status: 'applied', state: request.next };
  }
}


let evidenceDirectory;
const report = {
  schemaVersion: 1,
  harness: 'built-anchor-smoke',
  authority: 'explicit-nonproduction-disposable-sandbox',
  rootArtifact: ROOT_ARTIFACT,
  admission: false,
  productionGo: false,
  integrity: null,
  scenarios: [],
  cleanup: null,
  status: 'failed',
};

try {
  const options = parseArguments(process.argv.slice(2));
  await createNewEvidenceDirectory(options.evidenceDirectory);
  evidenceDirectory = options.evidenceDirectory;

  const integrity = await verifyBuiltPackage(options.packageDirectory, options.expectedProvenance);
  report.integrity = integrity.evidence;

  const packageModule = await import(
    pathToFileURL(integrity.publicEntryPath).href + `?provenance=${PROVENANCE_SHA256}`
  );
  const nativeModule = await import(
    pathToFileURL(integrity.nativeArtifactEntryPath).href + `?provenance=${PROVENANCE_SHA256}`
  );
  assertPublicSurface(packageModule);
  const anchorExecutablePath = await nativeModule.verifyOwnerAnchorNativeArtifact(
    pathToFileURL(`${options.packageDirectory}${path.sep}`)
  );
  assert(
    await sha256File(anchorExecutablePath) === `sha256:${NATIVE_SHA256}`,
    'native-public-verifier-digest-mismatch'
  );

  const cleanup = await runInDisposableSandbox({
    api: packageModule,
    anchorExecutablePath,
    scenarios: report.scenarios,
  });
  report.cleanup = cleanup;
  report.status = 'passed';
} catch (error) {
  report.failure = serializeError(error);
  process.exitCode = 1;
} finally {
  if (evidenceDirectory) {
    await writeFile(
      path.join(evidenceDirectory, REPORT_NAME),
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    ).catch((error) => {
      process.stderr.write(`built-anchor-smoke-evidence-write-failed:${serializeError(error).message}\n`);
      process.exitCode = 1;
    });
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, evidence: evidenceDirectory && path.join(evidenceDirectory, REPORT_NAME) })}\n`);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--package', '--evidence', '--expected-provenance-sha256'].includes(name) || !value) {
      throw new Error('usage: built-anchor-smoke.mjs --package /absolute/path --evidence /new/absolute/path --expected-provenance-sha256 <sha256>');
    }
    if (values.has(name)) throw new Error(`duplicate-argument:${name}`);
    values.set(name, value);
  }
  if (values.size !== 3) throw new Error('built-anchor-smoke-required-arguments-missing');
  const packageDirectory = values.get('--package');
  const evidenceDirectory = values.get('--evidence');
  assert(path.isAbsolute(packageDirectory), 'package-path-must-be-absolute');
  assert(path.isAbsolute(evidenceDirectory), 'evidence-path-must-be-absolute');
  assert(packageDirectory !== evidenceDirectory, 'package-and-evidence-paths-must-differ');
  const expectedProvenance = normalizeSha256(values.get('--expected-provenance-sha256'));
  assert(expectedProvenance === `sha256:${PROVENANCE_SHA256}`, 'unexpected-pinned-provenance-sha256');
  const resolvedPackage = path.resolve(packageDirectory);
  const resolvedEvidence = path.resolve(evidenceDirectory);
  assert(!resolvedEvidence.startsWith(`${resolvedPackage}${path.sep}`), 'evidence-directory-must-not-modify-package');
  return { packageDirectory: resolvedPackage, evidenceDirectory: resolvedEvidence, expectedProvenance };
}

async function createNewEvidenceDirectory(directory) {
  const canonicalParent = await realpath(path.dirname(directory));
  assert(path.join(canonicalParent, path.basename(directory)) === directory, 'evidence-parent-must-be-canonical');
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('evidence-directory-must-be-new');
    throw error;
  }
}

async function verifyBuiltPackage(packageDirectory, expectedProvenance) {
  const packageInfo = await lstat(packageDirectory);
  assert(packageInfo.isDirectory() && !packageInfo.isSymbolicLink(), 'package-root-must-be-real-directory');
  assert(await realpath(packageDirectory) === packageDirectory, 'package-root-must-be-canonical');

  const provenancePath = path.join(packageDirectory, 'provenance.json');
  const provenanceBytes = await readFile(provenancePath);
  assert(sha256Bytes(provenanceBytes) === expectedProvenance, 'provenance-sha256-mismatch');
  const provenance = JSON.parse(provenanceBytes.toString('utf8'));
  assert(provenance?.trust === 'provenance-only-not-signature-or-admission', 'provenance-trust-label-mismatch');
  assert(provenance?.artifact === 'owner-anchor-library', 'provenance-artifact-mismatch');
  assert(Array.isArray(provenance.outputs) && provenance.outputs.length > 0, 'provenance-outputs-missing');
  assert(provenance.capability?.nativeSha256 === `sha256:${NATIVE_SHA256}`, 'provenance-native-sha256-mismatch');

  const verifiedOutputs = [];
  let nativeVerified = false;
  for (const output of provenance.outputs) {
    assert(typeof output?.path === 'string' && isSafeRelativePath(output.path), 'unsafe-provenance-output-path');
    assert(/^sha256:[0-9a-f]{64}$/.test(output.sha256), `invalid-output-sha256:${output.path}`);
    const outputPath = path.resolve(packageDirectory, output.path);
    assert(outputPath.startsWith(`${packageDirectory}${path.sep}`), `output-escapes-package:${output.path}`);
    const info = await lstat(outputPath);
    assert(info.isFile() && !info.isSymbolicLink(), `output-not-regular-file:${output.path}`);
    const bytes = await readFile(outputPath);
    assert(bytes.byteLength === output.bytes, `output-size-mismatch:${output.path}`);
    assert(sha256Bytes(bytes) === output.sha256, `output-sha256-mismatch:${output.path}`);
    if (typeof output.mode === 'string') {
      assert((info.mode & 0o777).toString(8).padStart(4, '0') === output.mode, `output-mode-mismatch:${output.path}`);
    }
    verifiedOutputs.push({ path: output.path, sha256: output.sha256, bytes: output.bytes });
    if (output.path === 'native/process-anchor' && output.sha256 === `sha256:${NATIVE_SHA256}`) nativeVerified = true;
  }
  assert(nativeVerified, 'declared-native-output-not-verified');

  const packageJson = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  assert(packageJson?.name === '@agent-teams/owner-anchor-library', 'package-name-mismatch');
  assert(packageJson?.type === 'module', 'package-module-type-mismatch');
  const publicEntryPath = resolvePublicExport(packageDirectory, packageJson, '.');
  const nativeArtifactEntryPath = resolvePublicExport(packageDirectory, packageJson, './native-artifact');
  const outputPaths = new Set(verifiedOutputs.map((entry) => entry.path));
  assert(outputPaths.has(path.relative(packageDirectory, publicEntryPath)), 'public-entry-not-declared-output');
  assert(outputPaths.has(path.relative(packageDirectory, nativeArtifactEntryPath)), 'native-entry-not-declared-output');

  return {
    publicEntryPath,
    nativeArtifactEntryPath,
    evidence: {
      provenanceSha256: expectedProvenance,
      nativeSha256: `sha256:${NATIVE_SHA256}`,
      declaredOutputCount: verifiedOutputs.length,
      allDeclaredOutputHashesVerifiedBeforeSpawn: true,
      outputs: verifiedOutputs,
      trust: 'artifact-integrity-only-not-signed-admission',
    },
  };
}

function resolvePublicExport(packageDirectory, packageJson, exportName) {
  const target = packageJson?.exports?.[exportName]?.import ?? packageJson?.exports?.[exportName];
  assert(typeof target === 'string' && target.startsWith('./') && isSafeRelativePath(target), `invalid-public-export:${exportName}`);
  return path.resolve(packageDirectory, target);
}

function assertPublicSurface(api) {
  for (const name of [
    'AnchorProcessSupervisorAdapter',
    'NodeAnchorLaunchMaterializer',
    'NodeAnchorSpawner',
    'computeCanonicalArgvDigest',
    'parseExecutionUnitId',
    'parseLaneId',
    'parseOwnedProcessRef',
    'parseProcessControllerInstanceId',
    'parseRunId',
    'parseRuntimeBackendBindingId',
    'parseRuntimeBinaryId',
    'parseSpawnNonce',
    'parseTeamId',
    'parseWorkspaceId',
  ]) assert(typeof api[name] === 'function', `missing-public-export:${name}`);
}

async function runInDisposableSandbox({ api, anchorExecutablePath, scenarios }) {
  const sandboxPath = await mkdtemp(path.join(os.tmpdir(), SANDBOX_PREFIX));
  const ownerToken = randomUUID();
  const ownerPath = path.join(sandboxPath, '.built-anchor-smoke-owner');
  const projectPath = path.join(sandboxPath, 'project');
  const directAnchors = [];
  const cleanupState = { unknownResidual: false };
  let marker;
  let safeToDelete = false;
  let bodyCompleted = false;
  await writeFile(ownerPath, `${ownerToken}\n`, { encoding: 'utf8', mode: 0o600 });
  await mkdir(projectPath, { mode: 0o700 });
  await writeFile(path.join(projectPath, 'README.txt'), 'Disposable nonproduction built-anchor smoke project.\n', { mode: 0o600 });

  try {
    const nodePath = await realpath(NODE24_PATH);
    assert(path.isAbsolute(nodePath), 'node24-path-not-absolute');
    assert(await hasElfMagic(nodePath), 'node24-not-elf');
    marker = spawn(nodePath, ['-e', MARKER_PROGRAM], {
      cwd: projectPath,
      env: {},
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForStreamText(marker.stdout, 'MARKER_READY\n', 3_000, 4096);

    scenarios.push(await runScenario({ api, anchorExecutablePath, nodePath, sandboxPath, projectPath, directAnchors, cleanupState, wrongScope: false }));
    scenarios.push(await runScenario({ api, anchorExecutablePath, nodePath, sandboxPath, projectPath, directAnchors, cleanupState, wrongScope: true, marker }));
    assert(isChildLive(marker), 'unrelated-marker-not-preserved');
    await stopExactDirectChild(marker, 'unrelated-marker');
    safeToDelete = !cleanupState.unknownResidual && directAnchors.every((child) => !isChildLive(child)) && !isChildLive(marker);
    assert(safeToDelete, 'owned-direct-child-residual');
    bodyCompleted = true;
    return { sandboxDeleted: true, unknownResiduals: false, directAnchorCount: directAnchors.length, unrelatedMarkerPreserved: true };
  } finally {
    if (marker && isChildLive(marker)) await stopExactDirectChild(marker, 'unrelated-marker-finally').catch(() => undefined);
    for (const child of directAnchors) {
      if (!isChildLive(child)) continue;
      const control = child.stdio?.[0];
      if (control && typeof control.end === 'function') control.end();
      await waitForChildClose(child, OPERATION_TIMEOUT_MS).catch(() => undefined);
    }
    safeToDelete = safeToDelete || (!cleanupState.unknownResidual && directAnchors.every((child) => !isChildLive(child)) && (!marker || !isChildLive(marker)));
    if (safeToDelete) {
      if (await ownsSandbox(sandboxPath, ownerToken).catch(() => false)) {
        await rm(sandboxPath, { recursive: true, force: false });
      } else {
        report.cleanup = { sandboxDeleted: false, unknownResiduals: true, sandboxPath, reason: 'sandbox-ownership-marker-mismatch' };
        if (bodyCompleted) throw new Error('sandbox-ownership-marker-mismatch');
      }
    } else {
      report.cleanup = { sandboxDeleted: false, unknownResiduals: true, sandboxPath };
    }
  }
}

async function runScenario({ api, anchorExecutablePath, nodePath, sandboxPath, projectPath, directAnchors, cleanupState, wrongScope, marker }) {
  const suffix = wrongScope ? 'wrong-scope' : 'normal-stop';
  const initialDirectAnchorCount = directAnchors.length;
  const fixture = await createSupervisorFixture({ api, anchorExecutablePath, nodePath, sandboxPath, projectPath, directAnchors, suffix });
  let started;
  let drained = false;
  try {
    started = await withDeadline(fixture.adapter.start(fixture.startRequest), OPERATION_TIMEOUT_MS, `${suffix}-start`);
    assert(started.status === 'started', `${suffix}-start-${started.status}-${started.reason ?? 'unknown'}`);
    const transport = fixture.spawner.providerStdioFor(started.processRef);
    assert(transport, `${suffix}-provider-stdio-missing`);
    assert(transport.stdin !== transport.stdout && transport.stdout !== transport.stderr, `${suffix}-stdio-not-separated`);
    const stdout = collectBounded(transport.stdout, OUTPUT_LIMIT, `${suffix}-stdout`);
    const stderr = collectBounded(transport.stderr, OUTPUT_LIMIT, `${suffix}-stderr`);
    stdout.completion.catch(() => {}); stderr.completion.catch(() => {});
    report.providerDiagnostics = { scenario: suffix, get stdout() { return stdout.text; }, get stderr() { return stderr.text; } };
    const firstToken = `echo-${suffix}-${randomUUID()}`;
    transport.stdin.write(firstToken);
    await Promise.all([
      stdout.waitFor(`stdout:${firstToken}|node:`),
      stderr.waitFor(`stderr:${firstToken}|node:`),
    ]);

    let wrongScopeOutcome = null;
    if (wrongScope) {
      wrongScopeOutcome = await withDeadline(fixture.adapter.stop({
        ...fixture.stopRequest(started.processRef),
        executionUnitId: api.parseExecutionUnitId(`${suffix}-foreign-unit`),
        mode: 'immediate',
      }), OPERATION_TIMEOUT_MS, `${suffix}-fenced-stop`);
      assert(wrongScopeOutcome.status === 'unclassified_residual', 'wrong-scope-stop-not-fenced');
      assert(fixture.spawner.providerStdioFor(started.processRef) === transport, 'wrong-scope-stop-crossed-session');
      assert(isChildLive(marker), 'wrong-scope-stop-signalled-unrelated-marker');
      const secondToken = `still-live-${randomUUID()}`;
      transport.stdin.write(secondToken);
      await Promise.all([
        stdout.waitFor(`stdout:${secondToken}|node:`),
        stderr.waitFor(`stderr:${secondToken}|node:`),
      ]);
    }

    const stopped = await withDeadline(
      fixture.adapter.stop(fixture.stopRequest(started.processRef)),
      OPERATION_TIMEOUT_MS,
      `${suffix}-exact-stop`
    );
    assert(stopped.status === 'drained', `${suffix}-not-drained:${stopped.status}`);
    drained = true;
    const [stdoutText, stderrText] = await Promise.all([stdout.completion, stderr.completion]);
    assert(stdoutText.includes(`stdout:${firstToken}|node:24.`), `${suffix}-stdout-mismatch`);
    assert(stderrText.includes(`stderr:${firstToken}|node:24.`), `${suffix}-stderr-mismatch`);
    assert(fixture.spawner.providerStdioFor(started.processRef) === undefined, `${suffix}-transport-not-owned-eof`);
    const observed = await fixture.adapter.observe({
      planRef: fixture.planRef,
      executionUnitId: fixture.executionUnit.executionUnitId,
      processRef: started.processRef,
    });
    assert(observed.status === 'exited', `${suffix}-observe-not-exited`);
    return {
      name: suffix,
      publicSupervisor: 'AnchorProcessSupervisorAdapter',
      publicSpawner: 'NodeAnchorSpawner',
      publicMaterializer: 'NodeAnchorLaunchMaterializer',
      startStatus: started.status,
      execReady: true,
      providerSessionReadyClaimed: false,
      stdoutSeparated: true,
      stderrSeparated: true,
      wrongScopeOutcome: wrongScopeOutcome?.status ?? null,
      unrelatedMarkerLiveAfterWrongScope: wrongScope ? isChildLive(marker) : null,
      stopStatus: stopped.status,
      ownedEof: true,
    };
  } finally {
    if (started?.processRef && !drained) {
      const cleanup = await withDeadline(
        fixture.adapter.stop(fixture.stopRequest(started.processRef)),
        OPERATION_TIMEOUT_MS,
        `${suffix}-finally-stop`
      ).catch(() => ({ status: 'unclassified_residual' }));
      if (cleanup.status !== 'drained' && cleanup.status !== 'already_drained') {
        cleanupState.unknownResidual = true;
        report.cleanup = { sandboxDeleted: false, unknownResiduals: true, scenario: suffix };
      } else {
        drained = true;
      }
    }
    if (!drained && directAnchors.length > initialDirectAnchorCount) cleanupState.unknownResidual = true;
  }
}

async function createSupervisorFixture({ api, anchorExecutablePath, nodePath, sandboxPath, projectPath, directAnchors, suffix }) {
  const executableRef = `executable:${suffix}`;
  const workdirRef = `workdir:${suffix}`;
  const environmentRef = `environment:${suffix}`;
  const workspaceBinding = Object.freeze({
    workspaceId: api.parseWorkspaceId(`workspace_${sha256Text('a:' + suffix).slice(7, 39)}`),
    registrationRevision: 1,
    bindingGeneration: 1,
    mountGeneration: 1,
  });
  const grant = Object.freeze({ grantId: `grant:${suffix}`, ...workspaceBinding, permission: 'execute_process' });
  const binaryPolicy = Object.freeze({
    policy: 'registered_exact_binary',
    binaryId: api.parseRuntimeBinaryId(`node24-${suffix}`),
    binaryRevision: 1,
    binaryHash: await sha256File(nodePath),
  });
  const environmentPolicy = Object.freeze({ policy: 'explicit_allowlist', variables: Object.freeze([]) });
  const resourcePolicy = Object.freeze({ maxRuntimeMs: 45_000, gracefulStopMs: 250, maxOutputBytes: OUTPUT_LIMIT, maxProcessCount: 8 });
  const planRef = Object.freeze({
    teamId: api.parseTeamId(`team_${sha256Text('b:' + suffix).slice(7, 39)}`),
    runId: api.parseRunId(`run_${sha256Text('c:' + suffix).slice(7, 39)}`),
    generation: 1,
    planHash: `sha256:${sha256Text(`plan:${suffix}`).slice('sha256:'.length)}`,
  });
  const executionUnit = Object.freeze({
    executionUnitId: api.parseExecutionUnitId(`unit-${suffix}`),
    backendBinding: Object.freeze({ backend: 'provisioning_cli', bindingId: api.parseRuntimeBackendBindingId(`backend-${suffix}`), bindingRevision: 1 }),
    laneId: api.parseLaneId(`lane-${suffix}`),
    memberIds: Object.freeze([]),
    binaryPolicy,
    environmentPolicy,
    credentialExposureSet: Object.freeze({ secretRefs: Object.freeze([]) }),
    credentialIsolation: 'shared_execution_unit',
    resourcePolicy,
  });
  const argv = Object.freeze(['-e', PROVIDER_PROGRAM]);
  const launchSpec = Object.freeze({
    planRef,
    executionUnitId: executionUnit.executionUnitId,
    backend: 'provisioning_cli',
    argvAuthority: Object.freeze({ executableRef, binaryPolicy, argv, argvHash: api.computeCanonicalArgvDigest(argv) }),
    workdirAuthority: Object.freeze({ workdirRef, grant }),
    environmentAuthority: Object.freeze({ environmentRef, policy: environmentPolicy }),
    resourcePolicy,
  });
  const materializer = new api.NodeAnchorLaunchMaterializer({
    executables: [{ executableRef, executablePath: nodePath, binaryPolicy }],
    workdirs: [{ workdirRef, workdirPath: projectPath, grant, registeredRootEvidence: await inspectRegisteredRoot(projectPath) }],
    environments: [{ environmentRef, policy: environmentPolicy, values: {} }],
  });
  const ownerBinding = Object.freeze({ authorityId: `nonproduction-sandbox:${path.basename(sandboxPath)}`, bootId: `boot:${randomUUID()}` });
  const spawner = new api.NodeAnchorSpawner({
    anchorExecutablePath,
    neutralWorkingDirectory: sandboxPath,
    materializer,
    ownerBinding,
    providerStdio: 'pipe',
    spawnProcess(command, args, options) {
      const child = spawn(command, args, options);
      directAnchors.push(child);
      return child;
    },
  });
  const store = new InMemoryExactStore();
  const cancellation = Object.freeze({ cancellationId: `cancellation:${suffix}`, isCancellationRequested: () => false });
  const adapter = new api.AnchorProcessSupervisorAdapter({
    store,
    identities: {
      createProcessRef: () => api.parseOwnedProcessRef(`process-ref:${randomUUID()}`),
      createSpawnNonce: () => api.parseSpawnNonce(`spawn-nonce:${randomUUID()}`),
    },
    spawner,
    clock: { now: () => performance.now() },
    controllerInstanceId: api.parseProcessControllerInstanceId(`controller:${randomUUID()}`),
    launchTimeoutMs: SUPERVISOR_TIMEOUT_MS,
    stopTimeoutMs: SUPERVISOR_TIMEOUT_MS,
    recoveryTimeoutMs: SUPERVISOR_TIMEOUT_MS,
    ownerBinding,
    inventoryMode: 'hosted_authority',
  });
  const startRequest = Object.freeze({ executionUnit, launchSpec, cancellation });
  return {
    adapter,
    spawner,
    startRequest,
    planRef,
    executionUnit,
    stopRequest: (processRef) => ({ planRef, executionUnitId: executionUnit.executionUnitId, processRef, mode: 'graceful', cancellation }),
  };
}


function exactScope(left, right) {
  return left.executionUnitId === right.executionUnitId &&
    left.planRef.teamId === right.planRef.teamId && left.planRef.runId === right.planRef.runId &&
    left.planRef.generation === right.planRef.generation && left.planRef.planHash === right.planRef.planHash;
}

function collectBounded(stream, limit, label) {
  const chunks = [];
  let length = 0;
  let settled = false;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  const waiters = [];
  stream.on('data', (chunk) => {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) {
      const error = new Error(`${label}-limit`);
      rejectCompletion(error);
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      stream.destroy(error);
      return;
    }
    chunks.push(bytes);
    const text = Buffer.concat(chunks).toString('utf8');
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (text.includes(waiters[index].token)) waiters.splice(index, 1)[0].resolve();
    }
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    resolveCompletion(Buffer.concat(chunks).toString('utf8'));
  };
  stream.once('end', finish);
  stream.once('close', finish);
  stream.once('error', (error) => { if (!settled) { settled = true; rejectCompletion(error); } });
  stream.resume();
  return {
    get text() { return Buffer.concat(chunks).toString('utf8'); },
    completion,
    waitFor(token) {
      if (Buffer.concat(chunks).toString('utf8').includes(token)) return Promise.resolve();
      return withDeadline(new Promise((resolve, reject) => waiters.push({ token, resolve, reject })), OPERATION_TIMEOUT_MS, `${label}-token`);
    },
  };
}

async function inspectRegisteredRoot(rootPath) {
  const handle = await open(rootPath, constants.O_RDONLY | PORTABLE_O_CLOEXEC | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const info = await handle.stat({ bigint: true });
    const fdInfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
    const mountId = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(fdInfo)?.[1];
    assert(mountId, 'registered-workdir-mount-id-unavailable');
    return Object.freeze({ device: info.dev, inode: info.ino, mountId: BigInt(mountId) });
  } finally {
    await handle.close();
  }
}

async function ownsSandbox(sandboxPath, token) {
  const canonical = await realpath(sandboxPath);
  const prefix = path.join(await realpath(os.tmpdir()), SANDBOX_PREFIX);
  if (!canonical.startsWith(prefix)) return false;
  return await readFile(path.join(canonical, '.built-anchor-smoke-owner'), 'utf8') === `${token}\n`;
}

async function stopExactDirectChild(child, label) {
  if (!isChildLive(child)) return;
  assert(child.kill('SIGTERM'), `${label}-sigterm-not-delivered`);
  try {
    await waitForChildClose(child, 2_000);
  } catch {
    assert(child.kill('SIGKILL'), `${label}-sigkill-not-delivered`);
    await waitForChildClose(child, 2_000);
  }
}

function isChildLive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function waitForChildClose(child, timeoutMs) {
  if (!isChildLive(child)) return Promise.resolve();
  return withDeadline(new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  }), timeoutMs, 'direct-child-close');
}

function waitForStreamText(stream, expected, timeoutMs, limit) {
  return withDeadline(new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      text += chunk;
      if (text.length > limit) reject(new Error('marker-output-limit'));
      if (text.includes(expected)) resolve();
    });
    stream.once('error', reject);
    stream.once('end', () => reject(new Error('marker-output-eof-before-ready')));
  }), timeoutMs, 'marker-ready');
}

function withDeadline(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}-timeout`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sha256File(filePath) {
  const digest = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return `sha256:${digest.digest('hex')}`;
}

async function hasElfMagic(filePath) {
  const handle = await open(filePath, constants.O_RDONLY | PORTABLE_O_CLOEXEC | constants.O_NOFOLLOW);
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    return bytesRead === magic.length && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    await handle.close();
  }
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(value));
}

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeSha256(value) {
  const normalized = value?.startsWith('sha256:') ? value : `sha256:${value}`;
  assert(/^sha256:[0-9a-f]{64}$/.test(normalized), 'invalid-expected-provenance-sha256');
  return normalized;
}

function isSafeRelativePath(value) {
  return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function serializeError(error) {
  return { name: error?.name ?? 'Error', message: error?.message ?? String(error), code: error?.code ?? null };
}
