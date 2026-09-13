#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PINNED_PRODUCT = 'cff8868d093b4e899a6307850eb8b8841a87df62'
const PINNED_PROVENANCE = '3f284264827255e7ee356fa199765c128f367fc758f1a14808dd79647d6cb24e'
const PINNED_NATIVE = 'f892701ed9dfdedf1d6e966a1e05a93e952202ab636ae1bf8053bea0b121cbe0'
const NODE24 = '/usr/local/bin/node'
const REPORT_NAME = 'built-owner-anchor-adapter-smoke-evidence.json'
const SANDBOX_PREFIX = 'built-owner-anchor-adapter-smoke-'
const OWNER_MARKER = '.built-owner-anchor-adapter-smoke-owner'
const OUTPUT_LIMIT = 64 * 1024
const OPERATION_TIMEOUT_MS = 30_000
const STREAM_RELEASE_TIMEOUT_MS = 8_000
const PORTABLE_O_CLOEXEC = constants.O_CLOEXEC ?? 0

const PROVIDER_PROGRAM = String.raw`
if (!process.versions.node.startsWith('24.')) {
  process.stderr.write('wrong-node-major:' + process.versions.node + '\n');
  process.exit(72);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (input) => {
  process.stdout.write('OUT<' + input + '>:' + process.versions.node + '\n');
  process.stderr.write('ERR<' + input + '>:' + process.versions.node + '\n');
});
setInterval(() => {}, 1000);
`

const MARKER_PROGRAM = String.raw`
process.stdout.write('RETAINED_MARKER_READY\n');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`

class ExplicitNonproductionInMemoryProcessOwnershipStorePort {
  state

  async load(scope) {
    if (!this.state) return { status: 'missing' }
    return exactScope(this.state.intent.scope, scope)
      ? { status: 'found', state: this.state }
      : { status: 'missing' }
  }

  async loadByProcessRef(processRef) {
    return this.state?.intent.processRef === processRef
      ? { status: 'found', state: this.state }
      : { status: 'missing' }
  }

  async compareAndSwap(request) {
    const revision = this.state?.revision ?? null
    if (revision !== request.expectedRevision) return { status: 'conflict' }
    if (this.state && !exactScope(this.state.intent.scope, request.scope)) return { status: 'conflict' }
    report.fixtureOwnershipState = request.next
    this.state = request.next
    return { status: 'applied', state: request.next }
  }
}

let evidenceDirectory
const report = {
  schemaVersion: 1,
  harness: 'built-owner-anchor-adapter-smoke',
  product: PINNED_PRODUCT,
  authority: 'explicit-nonproduction-in-memory-store-disposable-fixture',
  claims: {
    productionAdmission: false,
    durableOwnerB: false,
    providerReadiness: false,
    signatureVerification: false,
    fullMvp: false,
  },
  externalExecutionBound: {
    requiredByRootRunner: 'dedicated systemd unit; MemoryMax=2G; RuntimeMaxSec=120s; shared heavy lock',
    harnessInternalOperationTimeoutMs: OPERATION_TIMEOUT_MS,
    enforcement: 'external bound is caller-owned and is not represented as a Product or adapter guarantee',
  },
  parentRuntime: null,
  integrity: null,
  actualOutcomes: null,
  cleanup: null,
  status: 'failed',
}

try {
  assert(typeof Bun === 'object' && /^1\.4(?:\.|$)/.test(Bun.version), `pinned-bun-1.4-required:${globalThis.Bun?.version ?? 'missing'}`)
  const options = parseArguments(process.argv.slice(2))
  await createNewEvidenceDirectory(options.evidenceDirectory)
  evidenceDirectory = options.evidenceDirectory

  const harnessPath = await canonicalFile(fileURLToPath(import.meta.url), 'harness')
  report.parentRuntime = {
    engine: 'Bun',
    version: Bun.version,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
  }

  const ownerSources = await resolveOwnerSources(options.ownerRepository)
  const packageEvidence = await inspectPinnedPackage(options.packageDirectory, options.expectedProvenance)
  report.integrity = {
    harnessSha256: await sha256File(harnessPath),
    ownerRepository: options.ownerRepository,
    ownerAdapterSource: { path: ownerSources.adapterPath, sha256: await sha256File(ownerSources.adapterPath) },
    ownerLoaderSource: { path: ownerSources.loaderPath, sha256: await sha256File(ownerSources.loaderPath) },
    packageRoot: options.packageDirectory,
    packageProvenanceSha256: packageEvidence.provenanceSha256,
    packageDeclaredOutputDigest: packageEvidence.declaredOutputDigest,
    nativeSha256: packageEvidence.nativeSha256,
  }

  const loaderModule = await importTs(ownerSources.loaderPath, 'loader')
  const adapterModule = await importTs(ownerSources.adapterPath, 'adapter')
  assert(typeof loaderModule.loadHostedOwnerAnchorLibrary === 'function', 'real-owner-loader-export-missing')
  assert(typeof adapterModule.HostedNativeAnchorAdapter === 'function', 'real-owner-adapter-export-missing')

  const admittedLibrary = await loaderModule.loadHostedOwnerAnchorLibrary(Object.freeze({
    admissionId: `nonproduction-smoke-admission:${randomUUID()}`,
    packageRoot: options.packageDirectory,
    expectedProvenanceSha256: options.expectedProvenance,
    expectedNativeSha256: `sha256:${PINNED_NATIVE}`,
  }))
  assert(admittedLibrary?.admission?.packageRoot === options.packageDirectory, 'loader-did-not-return-exact-package')
  assert(admittedLibrary?.anchorExecutablePath === path.join(options.packageDirectory, 'native/process-anchor'), 'loader-native-path-mismatch')

  const result = await runDisposableFixture({
    Adapter: adapterModule.HostedNativeAnchorAdapter,
    admittedLibrary,
  })
  report.actualOutcomes = result.outcomes
  report.cleanup = result.cleanup
  assert(result.cleanup.sandboxDeleted === true && result.cleanup.unknownResiduals === false, 'cleanup-not-proven')
  report.status = 'passed'
} catch (error) {
  report.failure = serializeError(error)
  process.exitCode = 1
} finally {
  if (evidenceDirectory) {
    const reportPath = path.join(evidenceDirectory, REPORT_NAME)
    try {
      await writeDurableExclusive(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    } catch (error) {
      process.stderr.write(`built-owner-anchor-adapter-evidence-write-failed:${serializeError(error).message}\n`)
      process.exitCode = 1
    }
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, evidence: evidenceDirectory ? path.join(evidenceDirectory, REPORT_NAME) : null })}\n`)
}

function parseArguments(argv) {
  const allowed = new Set(['--owner-repo', '--package', '--evidence', '--expected-provenance-sha256'])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(name) || !value) throw new Error(usage())
    if (values.has(name)) throw new Error(`duplicate-argument:${name}`)
    values.set(name, value)
  }
  if (values.size !== allowed.size) throw new Error(usage())
  const ownerRepository = requireAbsolute(values.get('--owner-repo'), 'owner-repo')
  const packageDirectory = requireAbsolute(values.get('--package'), 'package')
  const evidenceDirectory = requireAbsolute(values.get('--evidence'), 'evidence')
  const expectedProvenance = normalizeSha256(values.get('--expected-provenance-sha256'))
  assert(expectedProvenance === `sha256:${PINNED_PROVENANCE}`, 'unexpected-pinned-provenance-sha256')
  for (const source of [ownerRepository, packageDirectory]) {
    assert(evidenceDirectory !== source && !evidenceDirectory.startsWith(`${source}${path.sep}`), 'evidence-must-not-modify-input')
  }
  return { ownerRepository, packageDirectory, evidenceDirectory, expectedProvenance }
}

function usage() {
  return 'usage: built-owner-anchor-adapter-smoke.mjs --owner-repo /canonical/owner/repo --package /canonical/built/package --evidence /new/absolute/directory --expected-provenance-sha256 3f284264827255e7ee356fa199765c128f367fc758f1a14808dd79647d6cb24e'
}

function requireAbsolute(value, label) {
  assert(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label}-must-be-absolute`)
  return path.resolve(value)
}

async function createNewEvidenceDirectory(directory) {
  const canonicalParent = await realpath(path.dirname(directory))
  assert(path.join(canonicalParent, path.basename(directory)) === directory, 'evidence-parent-must-be-canonical')
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('evidence-directory-must-be-new')
    throw error
  }
}

async function resolveOwnerSources(ownerRepository) {
  await canonicalDirectory(ownerRepository, 'owner-repository')
  const adapterPath = path.join(ownerRepository, 'src/services/teamLifecycleOwner/HostedNativeAnchorAdapter.ts')
  const loaderPath = path.join(ownerRepository, 'src/services/teamLifecycleOwner/HostedOwnerAnchorLibrary.ts')
  await canonicalFile(adapterPath, 'owner-adapter-source')
  await canonicalFile(loaderPath, 'owner-loader-source')
  return { adapterPath, loaderPath }
}

async function inspectPinnedPackage(packageDirectory, expectedProvenance) {
  await canonicalDirectory(packageDirectory, 'package-root')
  const provenancePath = path.join(packageDirectory, 'provenance.json')
  const bytes = await readFile(await canonicalFile(provenancePath, 'package-provenance'))
  const provenanceSha256 = sha256Bytes(bytes)
  assert(provenanceSha256 === expectedProvenance, 'package-provenance-sha256-mismatch')
  const provenance = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  assert(provenance?.artifact === 'owner-anchor-library', 'package-artifact-mismatch')
  assert(provenance?.trust === 'provenance-only-not-signature-or-admission', 'package-trust-label-mismatch')
  assert(provenance?.capability?.nativeSha256 === `sha256:${PINNED_NATIVE}`, 'package-native-declaration-mismatch')
  assert(Array.isArray(provenance.outputs) && provenance.outputs.length > 0, 'package-outputs-missing')
  const normalizedOutputs = provenance.outputs.map(output => ({
    path: output.path,
    bytes: output.bytes,
    sha256: output.sha256,
  }))
  const native = normalizedOutputs.find(output => output.path === 'native/process-anchor')
  assert(native?.sha256 === `sha256:${PINNED_NATIVE}`, 'package-native-output-mismatch')
  return {
    provenanceSha256,
    nativeSha256: await sha256File(path.join(packageDirectory, 'native/process-anchor')),
    declaredOutputDigest: sha256Bytes(Buffer.from(JSON.stringify(normalizedOutputs))),
  }
}

async function importTs(filePath, role) {
  // Bun 1.4 is deliberately the TS loader. These imports are the gate checkout's real modules.
  return import(`${pathToFileURL(filePath).href}?actual-owner-smoke=${role}-${randomUUID()}`)
}

async function runDisposableFixture({ Adapter, admittedLibrary }) {
  const sandboxPath = await mkdtemp(path.join(os.tmpdir(), SANDBOX_PREFIX))
  const token = randomUUID()
  const projectPath = path.join(sandboxPath, 'project')
  const cleanup = {
    sandboxPath,
    markerStop: 'not_started',
    adapterStop: 'not_started',
    sandboxDeleted: false,
    unknownResiduals: false,
    secondaryErrors: [],
  }
  let marker
  let adapter
  let binding
  let cancellation
  let processRef
  let terminalProven = false
  let primaryError
  let outcomes

  await writeFile(path.join(sandboxPath, OWNER_MARKER), `${token}\n`, { mode: 0o600 })
  await mkdir(projectPath, { mode: 0o700 })
  await writeFile(path.join(projectPath, 'README.txt'), 'Disposable nonproduction actual Owner adapter smoke project.\n', { mode: 0o600 })

  try {
    const nodePath = await canonicalFile(NODE24, 'node24')
    assert(await hasElfMagic(nodePath), 'node24-is-not-elf')
    marker = spawn(nodePath, ['-e', MARKER_PROGRAM], {
      cwd: projectPath, env: {}, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForStreamText(marker.stdout, 'RETAINED_MARKER_READY\n', 3_000, 4096)

    const fixture = await createAdapterFixture({ Adapter, admittedLibrary, nodePath, projectPath, sandboxPath })
    adapter = fixture.adapter
    binding = fixture.binding
    cancellation = fixture.cancellation

    const started = await withDeadline(adapter.start(binding, cancellation), OPERATION_TIMEOUT_MS, 'owner-adapter-start')
    processRef = extractProcessRef(started)
    assert(started.status === 'started', `owner-adapter-start-not-started:${boundedJson(started)}`)
    assert(typeof processRef === 'string', 'owner-adapter-start-process-ref-missing')
    assert(started.anchorReady === 'committed_ownership_and_anchor_handshake_only', 'anchor-start-overclaimed-readiness')
    assert(started.stdio.stdin !== started.stdio.stdout && started.stdio.stdout !== started.stdio.stderr, 'provider-stdio-not-separated')
    const custody = fixture.custodies.get(processRef)
    assert(custody, 'claim-provider-stdio-not-called')
    assert(started.stdio === custody.stdio, 'adapter-did-not-return-claimed-real-transport')
    assert(custody.binding.orderedMembers.length === 1 && custody.binding.orderedMembers[0].ordinal === 3, 'original-roster-ordinal-not-preserved')

    const firstToken = `first-${randomUUID()}`
    started.stdio.stdin.write(firstToken)
    await Promise.all([
      custody.stdout.waitFor(`OUT<${firstToken}>:24.`),
      custody.stderr.waitFor(`ERR<${firstToken}>:24.`),
    ])

    const foreignBinding = createForeignBinding(admittedLibrary.library, binding)
    const wrongScope = await withDeadline(adapter.stop({
      binding: foreignBinding,
      processRef,
      mode: 'immediate',
      cancellation,
    }), OPERATION_TIMEOUT_MS, 'wrong-scope-stop')
    assert(wrongScope.status === 'uncertain', `wrong-scope-stop-not-fail-closed:${boundedJson(wrongScope)}`)
    assert(wrongScope.disposition?.required === true && wrongScope.disposition?.reason === 'scope_not_live', 'wrong-scope-disposition-missing')
    assert(isChildLive(marker), 'wrong-scope-stop-signalled-retained-marker')
    assert(custody.releaseCalls === 0, 'wrong-scope-stop-released-provider-consumers')

    const secondToken = `second-${randomUUID()}`
    started.stdio.stdin.write(secondToken)
    await Promise.all([
      custody.stdout.waitFor(`OUT<${secondToken}>:24.`),
      custody.stderr.waitFor(`ERR<${secondToken}>:24.`),
    ])
    assert(isChildLive(marker), 'fresh-echo-signalled-retained-marker')

    const stopped = await withDeadline(adapter.stop({
      binding, processRef, mode: 'graceful', cancellation,
    }), OPERATION_TIMEOUT_MS, 'exact-stop')
    assert(stopped.status === 'drained' || stopped.status === 'already_drained', `exact-stop-not-drained:${boundedJson(stopped)}`)
    await withDeadline(custody.releaseCompletion, STREAM_RELEASE_TIMEOUT_MS, 'consumer-release-join')
    assert(custody.releaseCalls === 1 && custody.releaseSettlements === 1, 'consumer-release-not-exactly-once-settled')
    assert(custody.stdout.text.includes(`OUT<${firstToken}>:24.`), 'independent-stdout-first-echo-missing')
    assert(custody.stderr.text.includes(`ERR<${firstToken}>:24.`), 'independent-stderr-first-echo-missing')
    assert(custody.stdout.text.includes(`OUT<${secondToken}>:24.`), 'independent-stdout-second-echo-missing')
    assert(custody.stderr.text.includes(`ERR<${secondToken}>:24.`), 'independent-stderr-second-echo-missing')

    const repeated = await withDeadline(adapter.stop({
      binding, processRef, mode: 'graceful', cancellation,
    }), OPERATION_TIMEOUT_MS, 'repeated-exact-stop')
    assert(repeated.status === 'already_drained' || repeated.status === 'drained', `repeated-stop-lost-terminal-binding:${boundedJson(repeated)}`)
    assert(repeated.disposition?.required !== true, 'repeated-stop-demanded-container-retirement')
    assert(custody.releaseCalls === 1 && custody.releaseSettlements === 1, 'repeated-stop-duplicated-consumer-release')

    const observed = await withDeadline(adapter.observe({ binding, processRef }), OPERATION_TIMEOUT_MS, 'known-terminal-observe')
    assert(observed.status === 'exited', `known-terminal-observe-not-exited:${boundedJson(observed)}`)
    // An unknown exit code is distinct from uncertainty about whether the exact binding drained.
    assert(observed.disposition?.required !== true, `known-terminal-observe-manufactured-uncertainty:${boundedJson(observed)}`)
    terminalProven = true

    outcomes = {
      originalRosterOrdinal: custody.binding.orderedMembers[0].ordinal,
      start: summarizeOutcome(started),
      firstEcho: { stdout: true, stderr: true },
      wrongScopeStop: summarizeOutcome(wrongScope),
      retainedMarkerLiveAfterWrongScope: isChildLive(marker),
      secondEchoAfterWrongScope: { stdout: true, stderr: true },
      exactStop: summarizeOutcome(stopped),
      repeatedExactStop: summarizeOutcome(repeated),
      observeAfterKnownDrain: summarizeOutcome(observed),
      consumerReleaseCalls: custody.releaseCalls,
      consumerReleaseSettlements: custody.releaseSettlements,
      stdoutBytes: Buffer.byteLength(custody.stdout.text),
      stderrBytes: Buffer.byteLength(custody.stderr.text),
    }
  } catch (error) {
    primaryError = error
  } finally {
    if (adapter && binding && processRef && !terminalProven) {
      try {
        const result = await withDeadline(adapter.stop({ binding, processRef, mode: 'immediate', cancellation }), OPERATION_TIMEOUT_MS, 'cleanup-exact-stop')
        cleanup.adapterStop = result.status
        terminalProven = result.status === 'drained' || result.status === 'already_drained'
        if (!terminalProven) cleanup.unknownResiduals = true
      } catch (error) {
        cleanup.adapterStop = 'failed'
        cleanup.unknownResiduals = true
        cleanup.secondaryErrors.push(serializeError(error))
      }
    } else if (terminalProven) {
      cleanup.adapterStop = 'known_terminal'
    } else {
      cleanup.adapterStop = 'no_exact_adapter_handle'
      cleanup.unknownResiduals = true
    }

    if (marker) {
      try {
        await stopExactRetainedChild(marker, 'retained-marker')
        cleanup.markerStop = 'exited'
      } catch (error) {
        cleanup.markerStop = 'failed'
        cleanup.unknownResiduals = true
        cleanup.secondaryErrors.push(serializeError(error))
      }
    }

    if (!cleanup.unknownResiduals && terminalProven && (!marker || !isChildLive(marker))) {
      try {
        assert(await ownsSandbox(sandboxPath, token), 'sandbox-owner-marker-mismatch')
        await rm(sandboxPath, { recursive: true, force: false })
        cleanup.sandboxDeleted = true
        delete cleanup.sandboxPath
      } catch (error) {
        cleanup.unknownResiduals = true
        cleanup.secondaryErrors.push(serializeError(error))
      }
    }
  }

  report.cleanup = cleanup
  if (primaryError) throw primaryError
  if (cleanup.unknownResiduals || !cleanup.sandboxDeleted) throw new Error('fixture-cleanup-not-proven')
  return { outcomes, cleanup }
}

async function createAdapterFixture({ Adapter, admittedLibrary, nodePath, projectPath, sandboxPath }) {
  const api = admittedLibrary.library
  const hex = label => createHash('sha256').update(label).digest('hex').slice(0, 32)
  const workspaceBinding = Object.freeze({
    workspaceId: api.parseWorkspaceId(`workspace_${hex('workspace')}`),
    registrationRevision: 1,
    bindingGeneration: 1,
    mountGeneration: 1,
  })
  const grant = Object.freeze({ grantId: 'grant:actual-owner-smoke', ...workspaceBinding, permission: 'execute_process' })
  const binaryPolicy = Object.freeze({
    policy: 'registered_exact_binary',
    binaryId: api.parseRuntimeBinaryId('node24:actual-owner-smoke'),
    binaryRevision: 1,
    binaryHash: await sha256File(nodePath),
  })
  const environmentPolicy = Object.freeze({ policy: 'explicit_allowlist', variables: Object.freeze([]) })
  const resourcePolicy = Object.freeze({ maxRuntimeMs: 45_000, gracefulStopMs: 250, maxOutputBytes: OUTPUT_LIMIT, maxProcessCount: 8 })
  const planRef = Object.freeze({
    teamId: api.parseTeamId(`team_${hex('team')}`),
    runId: api.parseRunId(`run_${hex('run')}`),
    generation: 1,
    planHash: sha256Bytes(Buffer.from('actual-owner-adapter-smoke-plan')),
  })
  const memberId = api.parseMemberId(`member_${hex('member-at-original-roster-ordinal-3')}`)
  const executionUnit = Object.freeze({
    executionUnitId: api.parseExecutionUnitId('unit:actual-owner-smoke'),
    backendBinding: Object.freeze({
      backend: 'provisioning_cli',
      bindingId: api.parseRuntimeBackendBindingId('backend:actual-owner-smoke'),
      bindingRevision: 1,
    }),
    laneId: api.parseLaneId('lane:actual-owner-smoke'),
    memberIds: Object.freeze([memberId]),
    binaryPolicy,
    environmentPolicy,
    credentialExposureSet: Object.freeze({ secretRefs: Object.freeze([]) }),
    credentialIsolation: 'shared_execution_unit',
    resourcePolicy,
  })
  const argv = Object.freeze(['-e', PROVIDER_PROGRAM])
  const launchSpec = Object.freeze({
    planRef,
    executionUnitId: executionUnit.executionUnitId,
    backend: 'provisioning_cli',
    argvAuthority: Object.freeze({
      executableRef: 'executable:node24:actual-owner-smoke',
      binaryPolicy,
      argv,
      argvHash: api.computeCanonicalArgvDigest(argv),
    }),
    workdirAuthority: Object.freeze({ workdirRef: 'workdir:actual-owner-smoke', grant }),
    environmentAuthority: Object.freeze({ environmentRef: 'environment:actual-owner-smoke', policy: environmentPolicy }),
    resourcePolicy,
  })
  const binding = Object.freeze({
    ownerPlanGeneration: `owner-plan-generation:${hex('owner-generation')}`,
    ownerUnitBindingId: `owner-unit-binding:${hex('owner-unit')}`,
    orderedMembers: Object.freeze([Object.freeze({ ordinal: 3, memberId })]),
    executionUnit,
    launchSpec,
  })
  const launchCatalog = Object.freeze({
    executables: Object.freeze([{ executableRef: launchSpec.argvAuthority.executableRef, executablePath: nodePath, binaryPolicy }]),
    workdirs: Object.freeze([{
      workdirRef: launchSpec.workdirAuthority.workdirRef,
      workdirPath: projectPath,
      grant,
      registeredRootEvidence: await inspectRegisteredRoot(projectPath),
    }]),
    environments: Object.freeze([{
      environmentRef: launchSpec.environmentAuthority.environmentRef,
      policy: environmentPolicy,
      values: Object.freeze({}),
    }]),
  })
  const custodies = new Map()
  const cancellation = Object.freeze({ cancellationId: 'cancellation:actual-owner-smoke', isCancellationRequested: () => false })
  const ownerBinding = Object.freeze({
    authorityId: `nonproduction-smoke:${path.basename(sandboxPath)}`,
    bootId: `boot:${randomUUID()}`,
  })
  const adapter = new Adapter({
    admittedLibrary,
    store: new ExplicitNonproductionInMemoryProcessOwnershipStorePort(),
    ownerBinding,
    controllerInstanceId: api.parseProcessControllerInstanceId(`controller:${randomUUID()}`),
    launchCatalog,
    neutralWorkingDirectory: sandboxPath,
    launchTimeoutMs: 8_000,
    stopTimeoutMs: 8_000,
    recoveryTimeoutMs: 8_000,
    claimProviderStdio(input) {
      assert(!custodies.has(input.processRef), 'provider-stdio-custody-claimed-twice')
      assert(input.binding.orderedMembers[0]?.ordinal === 3, 'claim-stdio-received-renumbered-roster')
      const stdout = attachBoundedConsumer(input.stdio.stdout, OUTPUT_LIMIT, 'provider-stdout')
      const stderr = attachBoundedConsumer(input.stdio.stderr, OUTPUT_LIMIT, 'provider-stderr')
      const record = {
        binding: input.binding,
        stdio: input.stdio,
        stdout,
        stderr,
        releaseCalls: 0,
        releaseSettlements: 0,
        releaseCompletion: new Promise(() => {}),
      }
      let releasePromise
      const custody = Object.freeze({
        processRef: input.processRef,
        stdoutConsumption: 'attached',
        stderrConsumption: 'attached',
        release() {
          record.releaseCalls += 1
          if (!releasePromise) {
            releasePromise = withDeadline(Promise.all([stdout.completion, stderr.completion]), STREAM_RELEASE_TIMEOUT_MS, 'owned-consumers-eof')
              .then(() => { record.releaseSettlements += 1 })
            record.releaseCompletion = releasePromise
          }
          return releasePromise
        },
      })
      custodies.set(input.processRef, record)
      return custody
    },
  })
  return { adapter, binding, cancellation, custodies }
}

function createForeignBinding(api, binding) {
  const executionUnitId = api.parseExecutionUnitId('unit:foreign-scope')
  return Object.freeze({
    ...binding,
    ownerUnitBindingId: `${binding.ownerUnitBindingId}:foreign`,
    executionUnit: Object.freeze({ ...binding.executionUnit, executionUnitId }),
    launchSpec: Object.freeze({ ...binding.launchSpec, executionUnitId }),
  })
}

function attachBoundedConsumer(stream, limit, label) {
  const chunks = []
  const waiters = []
  let bytes = 0
  let settled = false
  let resolveCompletion
  let rejectCompletion
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  // Observe early stream failures before stop joins the same rejecting promise.
  void completion.catch(() => {})
  const fail = error => {
    if (settled) return
    settled = true
    rejectCompletion(error)
    for (const waiter of waiters.splice(0)) waiter.reject(error)
  }
  stream.on('data', chunk => {
    const value = Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > limit) {
      fail(new Error(`${label}-output-limit`))
      stream.destroy()
      return
    }
    chunks.push(value)
    const text = Buffer.concat(chunks).toString('utf8')
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (text.includes(waiters[index].token)) waiters.splice(index, 1)[0].resolve()
    }
  })
  const finish = () => {
    if (settled) return
    settled = true
    resolveCompletion(Buffer.concat(chunks).toString('utf8'))
  }
  stream.once('end', finish)
  stream.once('close', () => {
    if (!settled) fail(new Error(`${label}-closed-before-end`))
  })
  stream.once('error', fail)
  // The real pipe is resumed only after this owned bounded reader and its error paths exist.
  stream.resume()
  return {
    completion,
    get text() { return Buffer.concat(chunks).toString('utf8') },
    waitFor(token) {
      if (Buffer.concat(chunks).toString('utf8').includes(token)) return Promise.resolve()
      return withDeadline(new Promise((resolve, reject) => waiters.push({ token, resolve, reject })), OPERATION_TIMEOUT_MS, `${label}-echo`)
    },
  }
}

async function inspectRegisteredRoot(rootPath) {
  const handle = await open(rootPath, constants.O_RDONLY | PORTABLE_O_CLOEXEC | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  try {
    const info = await handle.stat({ bigint: true })
    const fdInfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8')
    const mountId = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(fdInfo)?.[1]
    assert(mountId, 'registered-workdir-mount-id-unavailable')
    return Object.freeze({ device: info.dev, inode: info.ino, mountId: BigInt(mountId) })
  } finally {
    await handle.close()
  }
}

async function ownsSandbox(sandboxPath, token) {
  const canonical = await realpath(sandboxPath)
  const tmp = await realpath(os.tmpdir())
  assert(canonical.startsWith(path.join(tmp, SANDBOX_PREFIX)), 'sandbox-path-outside-owned-prefix')
  return await readFile(path.join(canonical, OWNER_MARKER), 'utf8') === `${token}\n`
}

async function stopExactRetainedChild(child, label) {
  if (!isChildLive(child)) return
  assert(child.kill('SIGTERM'), `${label}-sigterm-not-delivered`)
  try {
    await waitForChildClose(child, 2_000)
  } catch {
    assert(child.kill('SIGKILL'), `${label}-sigkill-not-delivered`)
    await waitForChildClose(child, 2_000)
  }
}

function isChildLive(child) {
  return child.exitCode === null && child.signalCode === null
}

function waitForChildClose(child, timeoutMs) {
  if (!isChildLive(child)) return Promise.resolve()
  return withDeadline(new Promise((resolve, reject) => {
    child.once('close', resolve)
    child.once('error', reject)
  }), timeoutMs, 'retained-child-close')
}

function waitForStreamText(stream, expected, timeoutMs, limit) {
  return withDeadline(new Promise((resolve, reject) => {
    let text = ''
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      text += chunk
      if (text.length > limit) reject(new Error('marker-output-limit'))
      if (text.includes(expected)) resolve()
    })
    stream.once('error', reject)
    stream.once('end', () => reject(new Error('marker-output-ended-before-ready')))
  }), timeoutMs, 'retained-marker-ready')
}

function extractProcessRef(result) {
  return result?.processRef ?? result?.productResult?.processRef ?? result?.retained?.processRef ?? result?.exactHandle?.processRef
}

function summarizeOutcome(value) {
  return JSON.parse(boundedJson(value))
}

function boundedJson(value) {
  const text = JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && ('stdin' in item || 'stdout' in item || 'stderr' in item)) return '[provider-stdio]'
    return typeof item === 'bigint' ? item.toString() : item
  })
  return text.length <= 4096 ? text : `${text.slice(0, 4096)}...[truncated]`
}

function exactScope(left, right) {
  return left.executionUnitId === right.executionUnitId &&
    left.planRef.teamId === right.planRef.teamId &&
    left.planRef.runId === right.planRef.runId &&
    left.planRef.generation === right.planRef.generation &&
    left.planRef.planHash === right.planRef.planHash
}

function withDeadline(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}-timeout`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function canonicalDirectory(value, label) {
  const canonical = await realpath(value)
  const info = await lstat(value)
  assert(canonical === value && info.isDirectory() && !info.isSymbolicLink(), `${label}-must-be-canonical-real-directory`)
  return canonical
}

async function canonicalFile(value, label) {
  const canonical = await realpath(value)
  const info = await lstat(value)
  assert(canonical === value && info.isFile() && !info.isSymbolicLink(), `${label}-must-be-canonical-real-file`)
  return canonical
}

async function writeDurableExclusive(filePath, contents) {
  const handle = await open(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(contents, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function hasElfMagic(filePath) {
  const handle = await open(filePath, constants.O_RDONLY | PORTABLE_O_CLOEXEC | constants.O_NOFOLLOW)
  try {
    const magic = Buffer.alloc(4)
    const result = await handle.read(magic, 0, 4, 0)
    return result.bytesRead === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  } finally {
    await handle.close()
  }
}

async function sha256File(filePath) {
  const digest = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', chunk => digest.update(chunk))
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  return `sha256:${digest.digest('hex')}`
}

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function normalizeSha256(value) {
  const normalized = value?.startsWith('sha256:') ? value : `sha256:${value}`
  assert(/^sha256:[a-f0-9]{64}$/.test(normalized), 'invalid-expected-provenance-sha256')
  return normalized
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function serializeError(error) {
  return {
    name: String(error?.name ?? 'Error').slice(0, 128),
    message: String(error?.message ?? error).slice(0, 4096),
    code: error?.code == null ? null : String(error.code).slice(0, 128),
    stack: typeof error?.stack === 'string' ? error.stack.slice(0, 8192) : null,
  }
}
