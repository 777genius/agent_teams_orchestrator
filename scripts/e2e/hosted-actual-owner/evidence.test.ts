import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { renameSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildAcceptanceEvidence, validateAcceptanceEvidence } from './evidence.js'
import type { ActualOwnerProcessAnchor } from './process-anchor.js'
import type { ActualOwnerProcessAnchorVerifier } from './process-anchor.js'

const ownerExecutable = Buffer.from('sealed-owner-executable')
const ownerExecutableSha256 = `sha256:${createHash('sha256')
  .update(ownerExecutable).digest('hex')}` as const
const ownerArtifact = Object.freeze({
  kind: 'sealed-build' as const,
  executable: '/closure/dist/local-cli/hostedActualOwnerLauncher-' + '9'.repeat(64),
  sha256: ownerExecutableSha256,
  buildClosureSha256: `sha256:${'8'.repeat(64)}` as const,
})

const config = {
  admissionFile: '/tmp/sandbox/team/hosted-approval-runtime-admission.v1.json',
  controlSocket: '/tmp/sandbox/control.sock', evidenceFile: '/tmp/sandbox/evidence.json',
  hostedControlConfig: '/tmp/sandbox/config.json', markerPath: '/tmp/sandbox/marker',
  openCodeExecutable: '/opt/opencode', openCodeSha256: 'a'.repeat(64),
  productRoot: '/product',
  productPublicationTimeoutMs: 30_000,
  repositoryRoot: '/repo', orchestratorRef: 'd'.repeat(40),
  ownerArtifact,
  runtimeManifestPath: '/tmp/sandbox/manifest.json',
  sandboxRoot: '/tmp/sandbox', walFile: '/tmp/sandbox/team/hosted-approval-owner.v1.json',
  runtime: {
    schemaVersion: 1 as const, purpose: 'agent-teams.hosted-actual-owner-e2e/v1' as const,
    runId: 'b'.repeat(48), sandboxRoot: '/tmp/sandbox', markerPath: '/tmp/sandbox/marker',
    capture: { ownerWalTimelinePath: '/tmp/sandbox/owner.ndjson' },
    refs: { openCode: 'c'.repeat(40), openCodeExecutableSha256: 'a'.repeat(64),
      orchestrator: 'd'.repeat(40), product: 'e'.repeat(40) },
  },
}

const processAnchor: ActualOwnerProcessAnchor = Object.freeze({
  schemaVersion: 1,
  purpose: 'agent-teams.hosted-actual-owner-e2e.process-anchor/v1',
  platform: 'linux',
  pid: 42,
  startTimeTicks: '123456',
  bootId: '12345678-1234-1234-1234-123456789abc',
  pidNamespace: 'pid:[4026531836]',
  executableSha256: ownerExecutableSha256,
})

const identity = { device: '1', inode: '2', size: '3', mtimeNs: '4', ctimeNs: '5' }
const admission = {
  digest: 'f'.repeat(64),
  admissionGeneration: 'approval-admission-generation_test',
}

function walBytes(revision = 1): Buffer {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    revision,
    admissionDigest: admission.digest,
    admissionGeneration: admission.admissionGeneration,
    routes: [],
    actorMembers: {},
    ingress: [],
    retiredIngress: [],
    deliveries: [],
    writerFence: {
      generation: `approval-writer-fence_${'a'.repeat(32)}`,
      dev: '1',
      ino: '2',
    },
  })}\n`)
}

function walSource(bytes = walBytes()) {
  return {
    identity,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    observedAtUnixMs: 100,
  }
}

function currentProcessVerifier(
  secondStartTime = processAnchor.startTimeTicks,
): ActualOwnerProcessAnchorVerifier {
  let statReads = 0
  return {
    platform: 'linux',
    readFile: path => {
      if (path === '/proc/sys/kernel/random/boot_id') return processAnchor.bootId
      statReads += 1
      const startTime = statReads === 1 ? processAnchor.startTimeTicks : secondStartTime
      return `${processAnchor.pid} (owner) ${[
        'S', ...Array.from({ length: 18 }, () => '0'), startTime,
      ].join(' ')}`
    },
    readlink: () => processAnchor.pidNamespace,
    readExecutable: () => ownerExecutable,
  }
}

function currentEvidenceVerifier(bytes = walBytes()) {
  return {
    trustedOwnerArtifact: ownerArtifact,
    process: currentProcessVerifier(),
    processStartedAtNs: () => 1n,
    readWalSource: () => ({ bytes, identity }),
    now: () => 100,
  }
}

function readyEvidence(revision = 1) {
  const bytes = walBytes(revision)
  return buildAcceptanceEvidence({
    config, processAnchor, status: 'ready', admission,
    ownerSocket: '/tmp/sandbox/team/owner.sock',
    state: { revision, ingress: [], deliveries: [] },
    walSource: walSource(bytes),
    publication: { hostedControlConfig: identity, admission: { ...identity, inode: '6' } },
  })
}

async function filesystemEvidence(sandbox: string, walPath: string, bytes: Buffer) {
  const stat = await lstat(walPath, { bigint: true })
  const actualIdentity = {
    device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
  }
  return buildAcceptanceEvidence({
    config: { ...config, sandboxRoot: sandbox, walFile: walPath },
    processAnchor,
    status: 'ready',
    admission,
    ownerSocket: join(sandbox, 'team', 'owner.sock'),
    state: { revision: 1, ingress: [], deliveries: [] },
    walSource: {
      identity: actualIdentity,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      observedAtUnixMs: Date.now(),
    },
    publication: { hostedControlConfig: identity, admission: { ...identity, inode: '6' } },
  })
}

async function compileRenameExchange(root: string): Promise<string> {
  const source = join(root, 'rename-exchange.c')
  const executable = join(root, 'rename-exchange')
  await writeFile(source, [
    '#define _GNU_SOURCE',
    '#include <fcntl.h>',
    '#include <stdio.h>',
    'int main(int argc, char **argv) {',
    '  if (argc != 3) return 2;',
    '  if (renameat2(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_EXCHANGE) != 0) {',
    '    perror("renameat2"); return 1;',
    '  }',
    '  return 0;',
    '}',
    '',
  ].join('\n'), { mode: 0o600 })
  const compile = spawnSync('/usr/bin/cc', [source, '-o', executable], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
  })
  if (compile.status !== 0) throw new Error(`rename-exchange compile failed: ${compile.stderr}`)
  return executable
}

describe('hosted actual-owner acceptance evidence', () => {
  test('emits the exact machine-readable readiness and decision-control schema', () => {
    const evidence = readyEvidence()
    expect(validateAcceptanceEvidence(evidence, currentEvidenceVerifier())).toEqual(evidence)
    expect(evidence.publication.admission?.inode).toBe('6')
    expect(evidence.owner.walRevision).toBe(1)
    expect(evidence.owner.readyAnchor).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(evidence.owner.decisionOperations).toEqual([
      'approval_decision_deliver', 'approval_decision_reconcile',
    ])
  })

  test('rejects schema extension and non-sha256 artifact identity', () => {
    const evidence = buildAcceptanceEvidence({ config, processAnchor, status: 'starting' })
    expect(() => validateAcceptanceEvidence({ ...evidence, enabled: true })).toThrow(/evidence_invalid/)
    expect(() => validateAcceptanceEvidence(
      { ...evidence, artifact: { ...evidence.artifact, sha256: 'nope' } },
      currentEvidenceVerifier(),
    ))
      .toThrow(/evidence_invalid/)
    expect(() => validateAcceptanceEvidence({
      ...evidence,
      owner: { ...evidence.owner, processAnchor: { pid: evidence.owner.pid } },
    }, currentEvidenceVerifier())).toThrow(/process_anchor_invalid/)
  })

  test('requires composition-trusted owner bytes and the matching running executable', () => {
    const evidence = readyEvidence()
    expect(() => validateAcceptanceEvidence(evidence)).toThrow(/owner_artifact_trust_missing/)
    expect(() => validateAcceptanceEvidence(evidence, {
      ...currentEvidenceVerifier(),
      trustedOwnerArtifact: { ...ownerArtifact, sha256: `sha256:${'7'.repeat(64)}` },
    })).toThrow(/owner_artifact_trust_mismatch/)
    expect(() => validateAcceptanceEvidence(evidence, {
      ...currentEvidenceVerifier(),
      process: { ...currentProcessVerifier(), readExecutable: () => Buffer.from('decoy') },
    })).toThrow(/process_anchor_stale/)
    const sourceArtifact = { ...ownerArtifact, kind: 'source-smoke' as const }
    expect(() => validateAcceptanceEvidence({
      ...evidence, ownerArtifact: sourceArtifact,
    }, {
      ...currentEvidenceVerifier(), trustedOwnerArtifact: sourceArtifact,
    })).toThrow(/owner_artifact_not_production/)
  })

  test('fails closed for invalid refs, paths, admission, publication, WAL, and failure fields', () => {
    const evidence = buildAcceptanceEvidence({ config, processAnchor, status: 'starting' })
    const invalid: unknown[] = [
      { ...evidence, refs: null },
      { ...evidence, refs: { ...evidence.refs, orchestrator: null } },
      { ...evidence, refs: { ...evidence.refs, openCode: 'main' } },
      { ...evidence, markerPath: 'marker.json' },
      { ...evidence, artifact: { ...evidence.artifact, executable: './opencode' } },
      { ...evidence, admission: { ...evidence.admission, path: 'admission.json' } },
      { ...evidence, admission: { ...evidence.admission, digest: 'f'.repeat(64) } },
      { ...evidence, admission: {
        ...evidence.admission,
        digest: 'f'.repeat(64),
        generation: 'wrong-generation',
      } },
      { ...evidence, admission: {
        ...evidence.admission,
        digest: 'f'.repeat(64),
        generation: 'approval-admission-generation_test',
      } },
      { ...evidence, publication: { ...evidence.publication, admission: 'not-an-identity' } },
      { ...evidence, publication: {
        hostedControlConfig: { device: '-1', inode: '2', size: '3', mtimeNs: '4', ctimeNs: '5' },
        admission: { device: '1', inode: '2', size: '3', mtimeNs: '4', ctimeNs: '5' },
      } },
      { ...evidence, owner: { ...evidence.owner, controlSocket: 7 } },
      { ...evidence, owner: { ...evidence.owner, controlSocket: 'control.sock' } },
      { ...evidence, owner: { ...evidence.owner, ownerSocket: 7 } },
      { ...evidence, owner: { ...evidence.owner, walPath: 'owner.wal' } },
      { ...evidence, owner: { ...evidence.owner, walRevision: -1 } },
      { ...evidence, owner: { ...evidence.owner, walRevision: 0 } },
      { ...evidence, owner: { ...evidence.owner, walRevision: '1' } },
      { ...evidence, owner: { ...evidence.owner, walSource: {} } },
      { ...evidence, owner: { ...evidence.owner, readyAnchor: 'sha256:nope' } },
      { ...evidence, owner: { ...evidence.owner, ingressCount: -1 } },
      { ...evidence, owner: { ...evidence.owner, deliveryCount: 1 } },
      { ...evidence, owner: { ...evidence.owner, decisionOperations: ['approval_decision_deliver'] } },
      { ...evidence, failure: { message: 'failed' } },
      { ...evidence, failure: 'failure-on-nonfailed-status' },
      { ...evidence, status: 'failed' },
    ]
    for (const candidate of invalid) {
      expect(() => validateAcceptanceEvidence(candidate)).toThrow()
    }
  })

  test('rejects semantically incomplete ready evidence', () => {
    const evidence = buildAcceptanceEvidence({ config, processAnchor, status: 'starting' })
    expect(() => validateAcceptanceEvidence(
      { ...evidence, status: 'ready' }, currentEvidenceVerifier(),
    ))
      .toThrow(/evidence_invalid/)
  })

  test('rejects stale process anchors and missing ready WAL evidence', () => {
    const evidence = readyEvidence()
    expect(() => validateAcceptanceEvidence(
      evidence, { ...currentEvidenceVerifier(), process: currentProcessVerifier('123457') },
    )).toThrow(/process_anchor_stale/)
    expect(() => validateAcceptanceEvidence({
      ...evidence,
      owner: {
        ...evidence.owner,
        walRevision: null,
        walSource: null,
        readyAnchor: null,
      },
    }, currentEvidenceVerifier())).toThrow(/evidence_invalid/)
  })

  test('rejects stale, fabricated, missing, malformed, and revision-0 WAL sources', () => {
    const evidence = readyEvidence()
    expect(() => validateAcceptanceEvidence(evidence, {
      ...currentEvidenceVerifier(),
      readWalSource: () => ({ bytes: walBytes(), identity: { ...identity, inode: '9' } }),
    })).toThrow(/wal_source_stale/)
    expect(() => validateAcceptanceEvidence({
      ...evidence,
      owner: { ...evidence.owner, readyAnchor: `sha256:${'0'.repeat(64)}` },
    }, currentEvidenceVerifier())).toThrow(/ready_anchor_invalid/)
    expect(() => validateAcceptanceEvidence(evidence, {
      ...currentEvidenceVerifier(),
      readWalSource: () => { throw new Error('missing') },
    })).toThrow(/wal_source_unavailable/)
    const malformed = Buffer.from('{"schemaVersion":2}\n')
    const malformedEvidence = buildAcceptanceEvidence({
      config, processAnchor, status: 'ready', admission,
      ownerSocket: '/tmp/sandbox/team/owner.sock',
      state: { revision: 1, ingress: [], deliveries: [] },
      walSource: walSource(malformed),
      publication: { hostedControlConfig: identity, admission: { ...identity, inode: '6' } },
    })
    expect(() => validateAcceptanceEvidence(malformedEvidence, {
      ...currentEvidenceVerifier(), readWalSource: () => ({ bytes: malformed, identity }),
    })).toThrow(/wal_source_malformed/)
    const futureIdentity = { ...identity, mtimeNs: '101000000' }
    const futureBytes = walBytes()
    const futureEvidence = buildAcceptanceEvidence({
      config, processAnchor, status: 'ready', admission,
      ownerSocket: '/tmp/sandbox/team/owner.sock',
      state: { revision: 1, ingress: [], deliveries: [] },
      walSource: {
        identity: futureIdentity,
        sha256: createHash('sha256').update(futureBytes).digest('hex'),
        observedAtUnixMs: 100,
      },
      publication: { hostedControlConfig: identity, admission: { ...identity, inode: '6' } },
    })
    expect(() => validateAcceptanceEvidence(futureEvidence, {
      ...currentEvidenceVerifier(),
      readWalSource: () => ({ bytes: futureBytes, identity: futureIdentity }),
    })).toThrow(/wal_source_freshness_invalid/)
    expect(() => validateAcceptanceEvidence(evidence, {
      ...currentEvidenceVerifier(), processStartedAtNs: () => 5n,
    })).toThrow(/wal_source_freshness_invalid/)
    const revisionZero = readyEvidence(0)
    expect(() => validateAcceptanceEvidence(revisionZero, currentEvidenceVerifier(walBytes(0))))
      .toThrow(/evidence_invalid/)
  })

  test('rejects a WAL atomically replaced after its descriptor is opened', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'actual-owner-wal-membership-'))
    try {
      await chmod(sandbox, 0o700)
      const team = join(sandbox, 'team')
      await mkdir(team, { mode: 0o700 })
      const walPath = join(team, 'hosted-approval-owner.v1.json')
      const replacementPath = join(team, 'replacement.json')
      const bytes = walBytes()
      await writeFile(walPath, bytes, { mode: 0o600 })
      await writeFile(replacementPath, bytes, { mode: 0o600 })
      const evidence = await filesystemEvidence(sandbox, walPath, bytes)
      expect(() => validateAcceptanceEvidence(evidence, {
        trustedOwnerArtifact: ownerArtifact,
        process: currentProcessVerifier(),
        processStartedAtNs: () => 1n,
        walReadAfterOpen: () => renameSync(replacementPath, walPath),
      })).toThrow(/wal_source_stale/)
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  test('rejects a WAL renamed away after its descriptor has been read', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'actual-owner-wal-read-membership-'))
    try {
      await chmod(sandbox, 0o700)
      const team = join(sandbox, 'team')
      await mkdir(team, { mode: 0o700 })
      const walPath = join(team, 'hosted-approval-owner.v1.json')
      const displaced = join(team, 'displaced.json')
      const bytes = walBytes()
      await writeFile(walPath, bytes, { mode: 0o600 })
      const evidence = await filesystemEvidence(sandbox, walPath, bytes)
      expect(() => validateAcceptanceEvidence(evidence, {
        trustedOwnerArtifact: ownerArtifact,
        process: currentProcessVerifier(),
        processStartedAtNs: () => 1n,
        walReadAfterRead: () => renameSync(walPath, displaced),
      })).toThrow(/wal_source_stale/)
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  test('rejects RENAME_EXCHANGE pathname drift after the WAL descriptor read', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'actual-owner-wal-read-exchange-'))
    try {
      await chmod(sandbox, 0o700)
      const team = join(sandbox, 'team')
      await mkdir(team, { mode: 0o700 })
      const walPath = join(team, 'hosted-approval-owner.v1.json')
      const exchanged = join(team, 'exchanged.json')
      const bytes = walBytes()
      await writeFile(walPath, bytes, { mode: 0o600 })
      await writeFile(exchanged, bytes, { mode: 0o600 })
      const evidence = await filesystemEvidence(sandbox, walPath, bytes)
      const exchange = await compileRenameExchange(sandbox)
      expect(() => validateAcceptanceEvidence(evidence, {
        trustedOwnerArtifact: ownerArtifact,
        process: currentProcessVerifier(),
        processStartedAtNs: () => 1n,
        walReadAfterRead: () => {
          const result = spawnSync(exchange, [walPath, exchanged], { encoding: 'utf8' })
          if (result.status !== 0) throw new Error(`rename-exchange failed: ${result.stderr}`)
        },
      })).toThrow(/wal_source_stale/)
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })
})
