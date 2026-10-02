import { cp, mkdir, readFile, chmod, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { fixture, operations, readers, variants, type Reader, type Variant } from './fixtures'
import { assess, boundaryGaps, decodeObservation } from './evidence'
import { command, sha256, snapshot, testProject, validateOutputRoots, safeWrite, protectedSourceRoots } from './isolation'

export const ownerSource = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const taskId = 'hosted-v1-opencode-dual-q0-preservation-20261001'
export const persistentRoot = tmpdir()
export async function buildWorker(destination?: string) {
  const sourceFiles = new Set<string>()
  const result = await Bun.build({ entrypoints: [path.join(ownerSource, 'scripts/opencode-generation-preservation/worker.ts')],
    write: false, target: 'bun', naming: 'reader-worker.js',
    plugins: [{ name: 'immutable-product-alias', setup(build) {
      build.onResolve({ filter: /^@main\// }, ({ path: requested }) => ({ path: path.join(ownerSource, '.task-inputs/product/src/main', requested.slice(6) + '.ts') }))
      build.onLoad({ filter: /\.ts$/ }, async ({ path: source }) => {
        sourceFiles.add(source)
        return { contents: await readFile(source, 'utf8'), loader: 'ts' }
      })
    } }] })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
  const files = await Promise.all([...sourceFiles].sort().map(async file => ({ path: file, sha256: sha256(await readFile(file)) })))
  if (destination) {
    await mkdir(destination, { recursive: true })
    await safeWrite(path.join(destination, 'reader-worker.js'), new Uint8Array(await result.outputs[0]!.arrayBuffer()))
  }
  return { executable: destination ? path.join(destination, 'reader-worker.js') : '', inputFiles: files }
}
export const ownerInputPaths = ['package.json', 'bun.lock', '.task-inputs/inputs.json', '.task-inputs/plan.md',
    'src/services/opencode/OpenCodeCommandOutcomeStore.ts', 'src/services/opencode/OpenCodeSessionStore.ts', 'src/services/opencode/OpenCodeHostManager.ts']
export type Options = { evidenceDir: string; testParent: string; selectedReaders?: Reader[]; selectedVariants?: Variant[]; trace?: boolean }
export async function runBaseline(options: Options) {
  options = { ...options, evidenceDir: path.resolve(options.evidenceDir), testParent: path.resolve(options.testParent) }
  const bun = path.join(ownerSource, '.task-inputs/toolchain/bun')
  if (Bun.version !== '1.3.11') throw new Error(`Pinned Bun 1.3.11 required, got ${Bun.version}`)
  const protectedRoots = await protectedSourceRoots(ownerSource)
  await validateOutputRoots(options.evidenceDir, options.testParent, protectedRoots)
  await mkdir(options.evidenceDir, { recursive: true })
  await safeWrite(path.join(options.evidenceDir, '.evidence-owner.json'), JSON.stringify({ taskId, root: await realpath(options.evidenceDir), purpose: 'fresh TEST public-reader evidence' }))
  const build = await buildWorker(path.join(options.evidenceDir, 'INPUT'))

  const ownerInputFiles = await Promise.all(ownerInputPaths.map(async file => ({ path: path.join(ownerSource, file), sha256: sha256(await readFile(path.join(ownerSource, file))) })))
  const cases: any[] = []
  for (const reader of options.selectedReaders ?? [...readers]) {
    for (const variant of options.selectedVariants ?? [...variants]) {
      for (const operation of operations(reader)) {
        const id = `${reader}-${variant}-${operation}`
        const recordDir = path.join(options.evidenceDir, 'cases', id)
        await mkdir(recordDir, { recursive: true })
        const test = await testProject(options.testParent, id, bun, protectedRoots)
        const original = fixture(reader, variant, test.project)
        await safeWrite(path.join(recordDir, 'test-marker.json'), JSON.stringify(test.marker, null, 2))
        await cp(build.executable, path.join(test.project, 'reader-worker.js'))
        await safeWrite(path.join(test.project, 'case-input.json'), JSON.stringify({ reader, operation, nonce: test.nonce,
          ownerSource, project: test.project, unreadable: variant === 'unreadable' }))
        if (original) {
          await safeWrite(path.join(test.project, 'store.json'), original)
          await safeWrite(path.join(recordDir, 'original.bin'), original)
        }
        const before = await snapshot(test.project)
        if (variant === 'unreadable') await chmod(path.join(test.project, 'store.json'), 0o000)
        const args = [bun, 'reader-worker.js']
        const tracePath = path.join(recordDir, 'syscalls.log')
        let processResult = await command(options.trace ? '/usr/bin/strace' : bun,
          options.trace ? ['-f', '-qq', '-e', 'trace=%file,%process,%network', '-o', tracePath, ...args] : ['reader-worker.js'], test.project, test.env)
        let traceStatus = options.trace ? 'CAPTURED' : 'NOT_REQUESTED'
        // ptrace launch failure is terminal; retry only if no reader was started.
        if (options.trace && processResult.code !== 0 && processResult.stderr.includes('ptrace') && !processResult.stdout) {
          await safeWrite(path.join(recordDir, 'trace-unavailable.json'), JSON.stringify(processResult, null, 2))
          processResult = await command(bun, ['reader-worker.js'], test.project, test.env)
          traceStatus = 'MISSING_PTRACE'
        }
        await safeWrite(path.join(recordDir, 'process.json'), JSON.stringify({ command: traceStatus === 'CAPTURED' ? ['/usr/bin/strace', '-f', '-qq', '-e', 'trace=%file,%process,%network', '-o', tracePath, ...args] : args,
          ...processResult, environmentKeyNames: Object.keys(test.env).sort(), traceStatus, childTerminal: true }, null, 2))
        const observation = decodeObservation(processResult)
        // Restore harness-owned unreadability after child has exited, solely to
        // hash/export bytes; reader effects are already recorded in stdout/trace.
        if (variant === 'unreadable') await chmod(path.join(test.project, 'store.json'), 0o644).catch(() => {})
        const after = await snapshot(test.project)
        if (after['store.json']) await safeWrite(path.join(recordDir, 'after.bin'), await readFile(path.join(test.project, 'store.json')))
        const added = Object.keys(after).filter(file => !before[file])
        const removed = Object.keys(before).filter(file => !after[file])
        const modified = Object.keys(before).filter(file => after[file] && after[file].sha256 !== before[file].sha256)
        for (const file of added.filter(file => file.endsWith('.quarantine'))) await safeWrite(path.join(recordDir, path.basename(file)), await readFile(path.join(test.project, file)))
        const originalChanged = (before['store.json']?.sha256 ?? null) !== (after['store.json']?.sha256 ?? null)
        const verdict = assess(reader, variant, operation, observation, originalChanged, added)
        const record = { id, reader, variant, operation, publicBoundary: true, evidenceKind: 'actual-public-file-reader',
          fixtureKind: 'independently-authored-format-contract', processTransport: reader === 'host' ? 'fake-identity-only; no native runtime' : 'none',
          qualification: observation.qualification, preservation: verdict, observation, originalChanged,
          before: before['store.json'] ?? null, after: after['store.json'] ?? null,
          fileEffects: { added, removed, modified }, beforeFiles: before, afterFiles: after,
          testProject: test.project, evidenceDir: recordDir, traceStatus,
          attemptedOperation: { operation, purpose: ['query', 'list-get', 'read', 'readRuntimeStoreManifestEvidenceData', 'resolveOwnedSessionEndpoint'].includes(operation) ? 'read' : 'write/prune/claim/lease-cleanup on expendable copy' },
          processes: { readerPid: processResult.pid, terminal: true, cleanup: 'No native process was launched; completed reader children reaped. TEST disk evidence retained.' } }
        await safeWrite(path.join(recordDir, 'observation.json'), JSON.stringify(record, null, 2))
        cases.push(record)
      }
    }
  }
  const report = { schemaVersion: 1, taskId, createdAt: new Date().toISOString(), scope: 'S5a pre-change preservation characterization only',
    ownerBaseSha: '6132299836a89e58d633a0557e504243035e806b', productBaseSha: '359417f642abb97429aa6eb1a92f3ce52254e5f4',
    planSha256: sha256(await readFile(path.join(ownerSource, '.task-inputs/plan.md'))),
    toolchain: { bun: Bun.version, executable: bun, sha256: sha256(await readFile(bun)) },
    gitPreflight: { status: 'NOT_ATTESTED', observed: 'The reader harness does not attest Git metadata. Attach a controller source seal for exact HEAD/base/index and owned output.' },
    bootstrap: { ownerFrozenInstall: 'NOT_ATTESTED_BY_HARNESS: attach the caller frozen-lock install receipt. Actual reader/dependency availability is recorded per case.', product: 'Bun bundles exact real readers and their relative/alias-resolved utilities; no product dependency installation or broad build needed.' },
    inputFiles: [...build.inputFiles, ...ownerInputFiles],
    inputPreservation: await Promise.all([...build.inputFiles, ...ownerInputFiles].map(async file => ({ ...file, afterSha256: sha256(await readFile(file.path)), unchanged: file.sha256 === sha256(await readFile(file.path)) }))),
    effectAudit: { nativeLaunchRequested: false, providerCredentialsInherited: false,
      syscallTrace: cases.every(c => c.traceStatus === 'CAPTURED') ? 'CAPTURED' : 'MISSING',
      limitation: 'File snapshots and forbidden-effect tripwires qualify their observed scope. Syscall trace availability is recorded per case; complete native process/network effects remain a separate gate.' },
    cases, boundaryGaps,
    counts: Object.fromEntries(['OBSERVED', 'FAIL', 'MISSING'].map(status => [status, cases.filter(c => c.preservation.status === status).length])),
    finalPreservationQualified: false, fullDualSupportQualified: false,
    noNativeRuntime: true, noModelProviderAgentLaunch: true,
    recommendations: {
      outcome: 'O4a: a single V2 outcome companion namespace. Unknown schema/read errors and silently filtered partial rows must veto upsert/prune/retry before writers. Read diagnostics alone are insufficient.',
      host: 'O1a: separate V2 registry/profile namespace; typed preserve-only registry inspection, complete leases/pins and existing-lock veto before reclaim/cleanup. Native lifecycle qualification remains open.',
      session: 'O1a: opencode-v2-sessions.json separate from default V1 store; reject containing partial/unknown authority before normalizing or claiming. Actual reader qualifications are recorded per case; native ownership remains open.',
      product: 'A2a: evidence reader must validate outer version as well as manifest data; VersionedJsonStore future failures must preserve only, without quarantine. Preserve missing versus known read-error.',
      downgrade: 'Never open V2 companion/profile data with old V1 readers. New app stops/exports V2, switches to verified V1 manifest, then old app opens legacy lanes. S5b must replay final namespaced stores; seamless active-V2 downgrade is unqualified.' }
  }
  await safeWrite(path.join(options.evidenceDir, 'store-preservation-baseline.json'), JSON.stringify(report, null, 2))
  return report
}
export async function sealArtifacts(dir: string) {
  const owned = [path.join(ownerSource, 'scripts/opencode-generation-preservation-baseline.ts'),
    ...(await readdir(path.join(ownerSource, 'scripts/opencode-generation-preservation'))).map(file => path.join(ownerSource, 'scripts/opencode-generation-preservation', file))]
  const ownedFiles = await Promise.all(owned.map(async file => ({ path: path.relative(ownerSource, file), sha256: sha256(await readFile(file)), bytes: (await readFile(file)).length })))
  const artifacts = await snapshot(dir)
  delete artifacts['artifact-manifest.json']
  await safeWrite(path.join(dir, 'artifact-manifest.json'), JSON.stringify({ schemaVersion: 1, taskId, ownedFiles, artifacts,
    gitMetadataAuditor: 'root controller', publication: 'none', patch: 'controller exports binary-safe owned paths including untracked sources' }, null, 2))
}
