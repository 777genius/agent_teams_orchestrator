import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createTestProject, assertTestProject, assertExternalDestination, gitLockPreflight, canonicalDestination, task } from './opencode-generation-client-contract/isolation';

const source = resolve(import.meta.dir, '..');
const bun = join(source, '.task-inputs/toolchain/bun');
export const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const pinnedBun = '6d5bb405b1d037a2a466b92757de7e47e4369930fa94bd42f8ff44ba49de6c57';
const planSha = 'fb4f8ed4fc4db9c62a555ad7b0fc27c8096acd2fd3a6905e5111e58ab2245d66';

export async function runSpike(evidenceDir: string) {
  const began = Date.now();
  const referenceOnly = process.env.S6_REFERENCE_ONLY === '1' || process.argv.includes('--reference-transport-only');
  evidenceDir = await assertExternalDestination(evidenceDir, source);
  const gitPreflight = await gitLockPreflight(source);
  await mkdir(evidenceDir, { recursive: true });
  const evidence = await mkdtemp(join(evidenceDir, 'run-'));
  if (sha(await readFile(bun)) !== pinnedBun || sha(await readFile(join(source, '.task-inputs/plan.md'))) !== planSha)
    throw new Error('Immutable input mismatch');
  const sandbox = await createTestProject(join(evidence, 'projects'), 'package-transport', source);
  await assertTestProject(sandbox.root, source);
  const referenceInputs = [];
  for (const version of ['2.0.0', '2.0.21']) for (const name of ['client', 'schema', 'protocol']) {
    const dir = `.task-inputs/reference/opencode-${name}-${version}`;
    for (const suffix of ['package/package.json', version === '2.0.0' ? 'qualification.json' : 'qualified-source.json',
      ...(name === 'client' ? ['package/dist/promise/generated/client.d.ts', 'package/dist/promise/generated/types.d.ts'] :
        name === 'protocol' ? ['package/dist/errors.js', 'package/dist/groups/session.js'] : [])]) {
      const path = join(source, dir, suffix);
      const bytes = await readFile(path);
      referenceInputs.push({ path, sha256: sha(bytes), bytes: bytes.length });
    }
  }
  await writeFile(join(evidence, 'reference-inputs.json'), JSON.stringify(referenceInputs, null, 2));
  // Immutable controller receipts describe the rejected predecessor, never this
  // revised patch. Preserve them independently of the worker's current results.
  const receiptDir = join(source, '.task-inputs/root-client-actual-20261002');
  const controllerReceipt = JSON.parse(await readFile(join(receiptDir, 'root-receipt.json'), 'utf8'));
  for (const name of ['root-receipt.json', 'client-transport.json', 'path-guard-repro.stdout', 'path-guard-repro.stderr'])
    await copyFile(join(receiptDir, name), join(evidence, `controller-predecessor-${name}`));
  const commands: unknown[] = [];
  let commandIndex = 0;
  async function command(args: string[], allowFailure = false) {
    await assertTestProject(sandbox.root, source);
    const started = Date.now();
    const child = Bun.spawn(args, { cwd: sandbox.root, env: sandbox.env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const log = join(evidence, `command-${++commandIndex}.txt`);
    await writeFile(log, stdout + stderr);
    commands.push({ args, cwd: sandbox.root, environmentKeys: Object.keys(sandbox.env),
      startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, exitCode, log, sha256: sha(stdout + stderr) });
    await writeFile(join(evidence, 'commands.json'), JSON.stringify(commands, null, 2));
    if (exitCode !== 0 && !allowFailure) throw new Error(`Command failed: ${args[1]} (${exitCode}); ${log}`);
    return { stdout, stderr, exitCode };
  }
  const version = await command([bun, '--version']);
  if (version.stdout.trim() !== '1.3.11') throw new Error('Wrong pinned Bun');
  const packageJSON = { name: `test-${task}`, private: true, type: 'module',
    dependencies: { '@opencode/client': '2.0.21', '@opencode/client-v2-floor': 'npm:@opencode/client@2.0.0' } };
  await writeFile(join(sandbox.root, 'package.json'), JSON.stringify(packageJSON, null, 2));
  // Registry refresh executes in the same explicit isolated child environment as installation.
  const registryScript = join(sandbox.root, 'registry.ts');
  await copyFile(join(source, 'scripts/opencode-generation-client-contract/registry.ts'), registryScript);
  sandbox.env.S6_EVIDENCE_DIR = evidence;
  sandbox.env.S6_TEST_ROOT = sandbox.root;
  sandbox.env.S6_SOURCE_ROOT = source;
  await copyFile(join(source, 'scripts/opencode-generation-client-contract/isolation.ts'), join(sandbox.root, 'isolation.ts'));
  // The worker network requires a local credential-free egress proxy. Admit only this
  // explicit installation input, and remove it before any loopback client execution.
  const proxyInput = process.env.S6_REGISTRY_PROXY;
  if (proxyInput) {
    const proxy = new URL(proxyInput);
    if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || proxy.username || proxy.password)
      throw new Error('Refusing nonlocal or credentialed registry proxy');
    sandbox.env.HTTPS_PROXY = proxy.href;
    sandbox.env.HTTP_PROXY = proxy.href;
    sandbox.env.NO_PROXY = '127.0.0.1,localhost';
  }
  let lock: Buffer | null = null;
  if (!referenceOnly) {
    await command([bun, registryScript]);
    await command([bun, 'install', '--ignore-scripts']);
    lock = await readFile(join(sandbox.root, 'bun.lock'));
    await command([bun, 'install', '--frozen-lockfile', '--ignore-scripts']);
    if (sha(lock) !== sha(await readFile(join(sandbox.root, 'bun.lock')))) throw new Error('Frozen install changed lock');
    await copyFile(join(sandbox.root, 'bun.lock'), join(evidence, 'test-package.bun.lock'));
  } else {
    sandbox.env.S6_REFERENCE_ONLY = '1';
    await writeFile(join(evidence, 'registry.json'), JSON.stringify({ status: 'MISSING',
      reason: 'Registry network access was rejected: domain is not on sandbox allowlist. No bypass attempted.',
      referenceOnly: true, installedAliasQualified: false }, null, 2));
  }
  delete sandbox.env.HTTPS_PROXY; delete sandbox.env.HTTP_PROXY; delete sandbox.env.NO_PROXY;
  await copyFile(join(sandbox.root, 'package.json'), join(evidence, 'test-package.json'));
  const testDir = join(sandbox.root, 'scripts/opencode-generation-client-contract');
  await mkdir(testDir, { recursive: true });
  for (const name of ['bounded-transport.ts', 'qualification.ts', 'package-proof.ts', 'http-proxy.cjs', 'isolation.ts'])
    await copyFile(join(source, 'scripts/opencode-generation-client-contract', name), join(testDir, name));
  await copyFile(join(testDir, 'qualification.ts'), join(testDir, 'qualification.test.ts'));
  sandbox.env.S6_TEST_ROOT = sandbox.root;
  sandbox.env.S6_SOURCE_ROOT = source;
  const packageProof = await command([bun, join(testDir, 'package-proof.ts')]);
  const firstRunnableMs = Date.now() - began;
  // Required public command: relative test directory in a fresh marked TEST Git package.
  const testRun = await command([bun, 'test', 'scripts/opencode-generation-client-contract', '--timeout', '15000'], true);
  const cases = JSON.parse(await readFile(join(evidence, 'case-results.json'), 'utf8'));
  const proved = (suffix: string) => ['floor', 'current'].every(dialect =>
    cases.some((item: any) => item.id === `${dialect}/${suffix}` && item.status === 'PASS'));
  const coverage = {
    fullBodyCaps: ['full-metadata-body-cap', 'full-transcript-body-cap', 'full-export-body-cap',
      'export-declared-error-metadata-cap'].every(proved) ? 'PASS' : 'MISSING',
    fullByteFrameAndLongSse: proved('full-frame-and-long-sse') ? 'PASS' : 'MISSING',
    controlledLiveRpcOverflowPeers: proved('sdk-lazy-cached-marker-overflow-peer') ? 'PASS' : 'MISSING',
    controlledEofRecreateLocalAbort: proved('sdk-eof-backlog-recreate-local-abort') ? 'PASS' : 'MISSING',
    scope: 'controlled transport with actual public SDK; NOT native/application readiness or release qualification',
  };
  const missing = [
    ...(referenceOnly ? ['Fresh official registry metadata/SRI and actual npm dual alias + distinct installed schema/protocol graph and frozen lock. Controller must allow official registry or supply immutable integrity-verified registry tarballs/cache.'] : []),
    ...(coverage.fullBodyCaps !== 'PASS' ? ['Full 8/32/128MiB operation body boundaries and 8MiB non-success cap'] : []),
    ...(coverage.fullByteFrameAndLongSse !== 'PASS' ? ['16MiB byte frame boundary and legitimate SSE greater than128MiB total within absolute lifetime'] : []),
    'Native event/RPC facts and native reconnection/peer survival (controlled public SDK live/RPC/overflow facts are separate)',
    'Revocable application/native readiness epoch: delayed lists, obsolete callbacks, live/durable overlap and admission fences; SDK cached-marker/EOF/new-source facts alone cannot prove it',
    'App observer byte/count queue overflow and durable reconciliation',
    'Applied cursor persistence failure and original-ID recovery',
    'Post-SDK decode/shape-validation and final authority/deadline fences; complete operation/native tag registry including session structured errors',
    'Native server tests await immutable Q0 S0 receipts; no native server was launched',
    'Real owner source/release-wrapper/compiled package and five native OS/architecture journeys',
  ].map((requirement, i) => ({ id: `S6-remaining-${i + 1}`, status: 'MISSING', requirement }));
  const report = { schemaVersion: 1, task, checkpoint: 'package-public-transport', completeS6: false,
    evidenceKind: 'official Promise package and controlled TEST transport contract; NOT native server proof',
    beganAt: new Date(began).toISOString(), elapsedMs: Date.now() - began, timeToFirstRunnableMs: firstRunnableMs,
    source: JSON.parse(await readFile(join(source, '.task-inputs/inputs.json'), 'utf8')),
    planSha256: planSha, bun: { version: '1.3.11', path: bun, sha256: pinnedBun },
    testRoot: sandbox.root, markerSha256: sha(await readFile(join(sandbox.root, '.test-project-owner.json'))),
    packageMode: referenceOnly ? 'read-only official reference inputs; NOT installed npm/alias qualification' : 'official registry installed',
    lockSha256: lock ? sha(lock) : null, packageProof: JSON.parse(packageProof.stdout), transportCoverage: coverage, cases, remaining: missing,
    testExitCode: testRun.exitCode, gitPreflight,
    controllerPredecessor: { receipt: controllerReceipt, scope: 'Controller NORMAL installed path on rejected predecessor; corrected patch requires independent controller rerun' },
    cleanup: 'All loopback servers and sockets closed by suite; no native host/shared resources started; TEST files retained for controller preservation.' };
  await writeFile(join(evidence, 'client-transport.json'), JSON.stringify(report, null, 2));
  const owned: { path: string; sha256: string; lines: number }[] = [];
  for (const path of ['scripts/opencode-generation-client-contract-spike.ts',
    ...(await readdir(join(source, 'scripts/opencode-generation-client-contract'))).map(n => `scripts/opencode-generation-client-contract/${n}`)]) {
    const bytes = await readFile(join(source, path));
    owned.push({ path, sha256: sha(bytes), lines: bytes.toString().split('\n').length - 1 });
  }
  const reportText = `# S6 package/public transport checkpoint\n\n` +
    `Full S6 and official V1+V2 support remain unqualified. This is a bounded TEST-only prerequisite at owner base ${report.source.ownerSourceSha}; product read-only ${report.source.productSourceSha}.\n\n` +
    `Pinned Bun ${version.stdout.trim()}; plan SHA256 ${planSha}. First runnable package fixture: ${firstRunnableMs}ms from harness start (does not include authoring). Test exit ${testRun.exitCode}.\n\n` +
    (referenceOnly ? `Registry/install/alias/dependency separation/frozen-lock gates are MISSING: official registry domain was rejected by the network sandbox. Transport cases execute exact read-only staged official Promise roots, without a fake client or copied SDK. This does not establish installed package integrity.\n\n` :
      `Official current/floor packages installed from refreshed registry with checked SRI, exact direct alias, distinct schema/protocol resolution, retained disposable lock and frozen reinstall.\n\n`) +
    `Source/minified/compiled fixture composition proves imports only, not owner release or native OS support.\n\n` +
    `Full-byte transport budgets: ${coverage.fullBodyCaps}; 16MiB frames and >128MiB legitimate lifetime: ${coverage.fullByteFrameAndLongSse}; live/RPC overflow peers: ${coverage.controlledLiveRpcOverflowPeers}; EOF/recreate/local-abort: ${coverage.controlledEofRecreateLocalAbort}. These are public SDK/controlled transport outcomes, not native facts.\n\n` +
    `Cases and independent HTTP request/effect/connection counters: client-transport.json and case-results.json. Commands/version/results: commands.json and command-*.txt. Source owned hashes: artifact-manifest.json. Registry metadata/SRI/archive/source comparisons: registry.json. Package graph: package-proof.json.\n\n` +
    `Controller predecessor receipt (preserved separately): NORMAL registry/SRI/alias/frozen install exit ${controllerReceipt.exitCode}, ${controllerReceipt.cases} transport PASS, lock ${controllerReceipt.lockSha256}, source hashes unchanged ${controllerReceipt.sourceHashesUnchanged}. This corrected patch has NOT yet had controller NORMAL rerun. Earlier late-guard patch was rejected; immutable receipt is not current patch approval.\n\n` +
    `Git preflight: ${JSON.stringify(report.gitPreflight)}\n\n` +
    `Remaining required S6 gates:\n${missing.map(x => `- MISSING: ${x.requirement}`).join('\n')}\n\n` +
    `Do not promote this candidate into production before native prerequisite decision. No production/dependency/public-pin edits, commit, merge, publication or unrelated cleanup. Controller must export binary-safe untracked patch and review/apply exact base.\n`;
  await writeFile(join(evidence, 'report.md'), reportText);
  const artifacts = [];
  for (const name of (await readdir(evidence)).sort()) {
    if (name === 'projects' || name === 'artifact-manifest.json') continue;
    const path = join(evidence, name);
    artifacts.push({ path, sha256: sha(await readFile(path)) });
  }
  await writeFile(join(evidence, 'artifact-manifest.json'), JSON.stringify({ schemaVersion: 1, task,
    createdAt: new Date().toISOString(), evidenceDir: evidence, owned, authoredLines: owned.reduce((n, f) => n + f.lines, 0), artifacts }, null, 2));
  // Self-contained output copies keep hashes/exact persistent locations plus the runnable authored sources.
  const output = join(source, '.task-output');
  const canonicalOutput = join(await realpath(source), '.task-output');
  async function exportPath(relative: string) {
    const destination = await canonicalDestination(join(output, relative));
    if (destination !== canonicalOutput && !destination.startsWith(canonicalOutput + sep))
      throw new Error('Authorized final export must remain inside .task-output');
    return destination;
  }
  await mkdir(await exportPath('owned-sources/opencode-generation-client-contract'), { recursive: true });
  for (const item of artifacts) await copyFile(item.path, await exportPath(item.path.split('/').at(-1)!));
  await copyFile(join(evidence, 'artifact-manifest.json'), await exportPath('artifact-manifest.json'));
  for (const file of owned) await copyFile(join(source, file.path), await exportPath(join('owned-sources', file.path.replace('scripts/', ''))));
  return report;
}

if (import.meta.main) {
  const index = process.argv.indexOf('--evidence-dir');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Required --evidence-dir <persistent job tmp/agent path>');
  const result = await runSpike(process.argv[index + 1]);
  console.log(JSON.stringify({ testExitCode: result.testExitCode, completeS6: false, testRoot: result.testRoot }));
  if (result.testExitCode) process.exitCode = result.testExitCode;
}
