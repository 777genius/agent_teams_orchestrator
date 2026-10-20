import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Isolated diagnostic branch only. Neither result is release qualification.
const sourceCommit = '5899164eaf0356e4b76a114b0b75313ec14a5047'
const sourceTree = 'bb2bef2a74e38bd7d3f3daca8b65c2bdf5e5727c'
const diagnosticParent = 'dd0d78492f4aa9705cd86e5a992bcc55766d8ae0'
const diagnosticParentTree = '0c38ac8765d48a14d3d7e6ef1776f2c8d2e01c93'
const fixture = 'src/cli/runtimeStatusCommand.entry.test.ts'
const controllerPath = 'scripts/ci/runtime-status-startup-diagnostic.ts'
const patchPath = 'scripts/ci/runtime-status-startup-diagnostic.patch'
const output = path.resolve('runtime-status-diagnostic-evidence')
const command = [process.execPath, 'test',
  'src/cli/handlers/runtime.status-stdout.test.ts',
  'src/cli/handlers/runtime.providers-stdout.test.ts',
  'src/cli/handlers/runtime.verify-stdout.test.ts',
  fixture,
  'src/cli/effectiveDefaultModel.entry.test.ts',
  'src/cli/handlers/anthropicCompatibleRuntime.integration.test.ts',
  'src/cli/handlers/model.test.ts',
  'src/services/runtimeBackends/effectiveDefaultModel.test.ts',
  'src/services/runtimeBackends/registry.anthropicCatalog.test.ts',
  'src/utils/sleep.test.ts',
  'src/services/teamBootstrap/teamBootstrapOwnedSpec.test.ts',
  'src/utils/swarm/memberSettingsFile.test.ts',
  'src/services/opencode/OpenCodeGatewayCredentialSnapshot.test.ts',
]
const expected = {
  'src/entrypoints/cli.tsx': 'b19c3ddfbb19acba3519d85ac506538d91428828e5d2170c2cfb385db9903f43',
  'src/cli/handlers/runtime.ts': 'f2ce038e9cf111890a822ac40e2b2cb8a2209fea6b06301ff05af438b69613e3',
  [fixture]: '412cdb51bb3d74a61893c0a7ae2a0007c066d6e872deab53d888b8e75da07ca4',
  'package.json': '01ebba249d6a69ed543d753eaaa1e917de715665936e5ccc869de20702d2a5aa',
  'bun.lock': '39669c0c961a92585bde9784439f2e24ef0fc9c34f61c683d14b819c7a63ade3',
}
const expectedPatchSha256 = '6cfc7abbb649ab3eb8be4fe36ee87b8b4877e84bd406cf8104ae926395657768'
const expectedInstrumented = {
  ...expected,
  'src/entrypoints/cli.tsx': 'fe1864fd46692ee8930d760e709241f298c4759fea8c1b2c266ec949e313a883',
  'src/cli/handlers/runtime.ts': 'a19b85f4027e59b114b9744fecc5cafd80474a1f1f5ea2f95b1f6a0bfe075bef',
  [fixture]: 'ea6fa1595fcde1c5b5e825938713077aaa15ca76476ccdad5ad7dbbb710ff779',
}
const maxLogBytes = 512 * 1024
mkdirSync(output, { recursive: true })
const metadata: Record<string, unknown> = {
  purpose: 'diagnostic-only; not PR or release qualification',
  sourceCommit, sourceTree, command, startedAt: new Date().toISOString(),
  platform: process.platform, arch: process.arch, bunVersion: process.versions.bun,
  runner: Object.fromEntries(['RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_REF'].map(key => [key, process.env[key] ?? null])),
}
function save(): void {
  writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n')
}
function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }).trim()
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function normalizeCrLf(raw: Buffer): Buffer {
  return Buffer.from(raw.filter((byte, index) => byte !== 13 || raw[index + 1] !== 10))
}
function worktreeIdentity(file: string, digest: string) {
  const raw = readFileSync(file)
  const normalized = normalizeCrLf(raw)
  const rawSha256 = hash(raw)
  const normalizedSha256 = hash(normalized)
  assert.equal(normalizedSha256, digest, `Source identity mismatch beyond CRLF: ${file}`)
  const crlfCount = raw.reduce((count, byte, index) => count + Number(byte === 13 && raw[index + 1] === 10), 0)
  const lfCount = raw.reduce((count, byte) => count + Number(byte === 10), 0)
  return { rawSha256, normalizedSha256, lineEndings: rawSha256 === digest ? 'blob-identical' : crlfCount === lfCount ? 'crlf' : 'mixed-lf-crlf' }
}
function verifyOriginals() {
  return Object.fromEntries(Object.entries(expected).map(([file, digest]) => {
    const blob = execFileSync('git', ['show', `${sourceCommit}:${file}`], { maxBuffer: 2 * 1024 * 1024 })
    assert.equal(hash(blob), digest, `Reviewed Git blob mismatch: ${file}`)
    return [file, { blobSha256: digest, ...worktreeIdentity(file, digest) }]
  }))
}
function preserveSources(prefix: string): void {
  // Package/lock identities are retained as hashes; only the three traced files need byte copies.
  for (const file of ['src/entrypoints/cli.tsx', 'src/cli/handlers/runtime.ts', fixture]) {
    // Bun treats file arguments as discovery filters; source copies must not be tests.
    const target = path.join(output, prefix, `${file}.txt`)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(file, target)
  }
}
type Outcome = { code: number | null; signal: string | null; spawnError: string | null; elapsedMs: number; stdoutBytes: number; stderrBytes: number; outputExceeded: boolean; testCount: number | null; fileCount: number | null; discoveryMatches: boolean }
async function runOnce(name: 'baseline' | 'traced'): Promise<Outcome> {
  const stdoutFile = path.join(output, `${name}.stdout.log`)
  const stderrFile = path.join(output, `${name}.stderr.log`)
  writeFileSync(stdoutFile, '')
  writeFileSync(stderrFile, '')
  const start = performance.now()
  let stdoutBytes = 0, stderrBytes = 0, outputExceeded = false
  let spawnError: string | null = null
  // Exact existing 13-file authority group: no preload, retries or wrapper deadline.
  const child = spawn(command[0]!, command.slice(1), { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const retain = (file: string, previous: number, chunk: Buffer) => {
    const remaining = Math.max(0, maxLogBytes - previous)
    if (chunk.length > remaining) outputExceeded = true
    if (remaining) appendFileSync(file, chunk.subarray(0, remaining))
  }
  child.stdout.on('data', (chunk: Buffer) => { retain(stdoutFile, stdoutBytes, chunk); stdoutBytes += chunk.length; process.stdout.write(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { retain(stderrFile, stderrBytes, chunk); stderrBytes += chunk.length; process.stderr.write(chunk) })
  const ending = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('error', error => { spawnError = error.message })
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const logs = readFileSync(stdoutFile, 'utf8') + '\n' + readFileSync(stderrFile, 'utf8')
  const summaries = [...logs.matchAll(/Ran (\d+) tests across (\d+) files\./g)]
  const testCount = summaries.length === 1 ? Number(summaries[0]![1]) : null
  const fileCount = summaries.length === 1 ? Number(summaries[0]![2]) : null
  const discoveryMatches = testCount === 91 && fileCount === 13
  const result = { ...ending, spawnError, elapsedMs: Math.round(performance.now() - start), stdoutBytes, stderrBytes, outputExceeded, testCount, fileCount, discoveryMatches }
  metadata[name] = result
  save()
  return result
}
function successful(outcome: Outcome): boolean {
  return outcome.code === 0 && outcome.signal === null && outcome.spawnError === null && !outcome.outputExceeded && outcome.discoveryMatches
}
let failed = true
save()
try {
  assert.equal(process.platform, 'win32')
  assert.equal(process.arch, 'x64')
  assert.equal(process.versions.bun, '1.4.3')
  metadata.checkoutCommit = git('rev-parse', 'HEAD')
  metadata.checkoutTree = git('rev-parse', 'HEAD^{tree}')
  try { metadata.coreAutocrlf = git('config', '--get', 'core.autocrlf') } catch { metadata.coreAutocrlf = null }
  assert.equal(git('rev-parse', 'HEAD^'), diagnosticParent, 'Correction must normally descend from the retained diagnostic')
  assert.equal(git('rev-parse', 'HEAD^^'), sourceCommit, 'Diagnostic source ancestry changed')
  assert.equal(git('rev-parse', `${diagnosticParent}^{tree}`), diagnosticParentTree)
  assert.equal(git('rev-parse', `${sourceCommit}^{tree}`), sourceTree)
  const sourceWorkflow = execFileSync('git', ['show', `${sourceCommit}:.github/workflows/ci.yml`], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  const group = /- name: Test runtime status and adjacent output boundaries\n(?:[^\n]*\n)*?        run: >-\n((?:          [^\n]+\n)+)/.exec(sourceWorkflow)
  assert(group, 'Reviewed authority command not found')
  const sourceCommand = group[1]!.trim().split(/\n/).map(line => line.trim()).join(' ')
  assert.equal(sourceCommand, ['bun', ...command.slice(1)].join(' '), 'Diagnostic command differs from reviewed authority group')
  metadata.sourceAuthorityCommand = sourceCommand
  writeFileSync(path.join(output, 'original-ci.yml'), sourceWorkflow)
  const branchFiles = git('diff', '--name-only', sourceCommit, 'HEAD').split(/\r?\n/).filter(Boolean)
  assert.deepEqual(branchFiles.sort(), ['.github/workflows/ci.yml', controllerPath, patchPath].sort())
  assert.equal(git('diff', '--name-only', 'HEAD'), '', 'Tracked checkout must be clean before baseline')
  metadata.diagnosticFiles = branchFiles
  metadata.originalHashesBeforeBaseline = verifyOriginals()
  metadata.controllerSha256 = hash(readFileSync(controllerPath))
  const committedPatch = execFileSync('git', ['show', `HEAD:${patchPath}`], { maxBuffer: 1024 * 1024 })
  assert.equal(hash(committedPatch), expectedPatchSha256, 'Unreviewed committed temporary patch')
  metadata.temporaryPatchIdentity = worktreeIdentity(patchPath, expectedPatchSha256)
  preserveSources('original-source')
  copyFileSync(controllerPath, path.join(output, 'controller.ts'))
  copyFileSync('.github/workflows/ci.yml', path.join(output, 'workflow.yml'))
  copyFileSync(patchPath, path.join(output, 'instrumentation.patch'))
  save()
  const baseline = await runOnce('baseline')
  // Always trace once after the one untouched baseline, including baseline failure.
  metadata.originalHashesAfterBaseline = verifyOriginals()
  assert.equal(git('diff', '--name-only', 'HEAD'), '', 'Baseline must not edit tracked source')
  // Only the traced diagnostic pass canonicalizes CRLF; baseline bytes stay untouched.
  for (const file of ['src/entrypoints/cli.tsx', 'src/cli/handlers/runtime.ts', fixture]) {
    writeFileSync(file, normalizeCrLf(readFileSync(file)))
  }
  metadata.tracedInputCanonicalHashes = verifyOriginals()
  metadata.tracedInputCanonicalization = 'after baseline only; three trace targets; CRLF to LF only'
  const canonicalPatch = path.join(output, 'instrumentation.canonical.patch')
  writeFileSync(canonicalPatch, normalizeCrLf(readFileSync(patchPath)))
  assert.equal(hash(readFileSync(canonicalPatch)), expectedPatchSha256)
  metadata.patchDryRun = git('apply', '--check', canonicalPatch)
  git('apply', canonicalPatch)
  const actualDiff = git('diff', '--no-ext-diff', '--binary') + '\n'
  writeFileSync(path.join(output, 'actual-instrumentation.diff'), actualDiff)
  metadata.instrumentationDiffSha256 = hash(Buffer.from(actualDiff))
  assert.deepEqual(git('diff', '--name-only').split(/\r?\n/).sort(), ['src/entrypoints/cli.tsx', 'src/cli/handlers/runtime.ts', fixture].sort())
  metadata.instrumentedHashes = Object.fromEntries(Object.entries(expectedInstrumented).map(([file, digest]) => [file, worktreeIdentity(file, digest)]))
  preserveSources('instrumented-source')
  save()
  const traced = await runOnce('traced')
  const phaseRecords: unknown[] = []
  for (const line of readFileSync(path.join(output, 'traced.stderr.log'), 'utf8').split(/\r?\n/)) {
    const match = /@@runtime-status-phase@@(\{.*\})/.exec(line)
    if (match) { try { phaseRecords.push(JSON.parse(match[1]!)) } catch { /* Error source snippets are not emitted records. */ } }
  }
  writeFileSync(path.join(output, 'phase-records.json'), JSON.stringify(phaseRecords, null, 2) + '\n')
  metadata.phaseRecordCount = phaseRecords.length
  failed = !successful(baseline) || !successful(traced) || phaseRecords.length === 0
} catch (error) {
  metadata.controllerError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
} finally {
  metadata.finishedAt = new Date().toISOString()
  metadata.diagnosticSucceeded = !failed
  metadata.qualificationApproved = false
  save()
  process.exitCode = failed ? 1 : 0
}
