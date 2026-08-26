import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendPrivateTimeline, assertCandidateArtifact, assertMarkerOwnedSandbox,
  assertProductionOwnerTrust, parseRuntimeManifest,
} from './contracts.js'

const root = '/tmp/actual-owner-' + 'a'.repeat(48) + '-ABC123'
const temporaryRoots: string[] = []

afterEach(async () => {
  for (const temporary of temporaryRoots.splice(0)) await rm(temporary, { recursive: true, force: true })
})

function manifest() {
  return {
    schemaVersion: 1,
    purpose: 'agent-teams.hosted-actual-owner-e2e/v1',
    runId: 'a'.repeat(48),
    sandboxRoot: root,
    markerPath: `${root}/.agent-teams-actual-owner-e2e-owner.json`,
    evidenceRoot: `${root}/evidence`,
    driverBaseUrl: 'http://127.0.0.1:49152/',
    productBaseUrl: 'http://127.0.0.1:49153/',
    approvalPath: '/hosted/approvals',
    browser: {},
    capture: {
      conditionalPostLedgerPath: `${root}/capture/posts.ndjson`,
      negativeResultsPath: `${root}/capture/negative.json`,
      openCodeTimelinePath: `${root}/capture/opencode.ndjson`,
      ownerWalTimelinePath: `${root}/capture/owner.ndjson`,
      productTimelinePath: `${root}/capture/product.ndjson`,
      protectedEffectLedgerPath: `${root}/capture/effects.json`,
    },
    refs: {
      openCode: 'b'.repeat(40), openCodeExecutableSha256: 'c'.repeat(64),
      orchestrator: 'd'.repeat(40), product: 'e'.repeat(40),
    },
  }
}

describe('hosted actual-owner acceptance preconditions', () => {
  test('rejects exported-API and generic-Bun authority without the signed artifact pin', () => {
    const forged = {
      kind: 'sealed-build' as const,
      executable: '/tmp/forged-owner',
      sha256: `sha256:${'1'.repeat(64)}` as const,
      buildClosureSha256: `sha256:${'2'.repeat(64)}` as const,
    }
    expect(() => assertProductionOwnerTrust(forged, undefined))
      .toThrow(/owner_artifact_trust_mismatch/)
    expect(() => assertProductionOwnerTrust(forged, `sha256:${'3'.repeat(64)}`))
      .toThrow(/owner_artifact_trust_mismatch/)
    expect(() => assertProductionOwnerTrust(forged, forged.sha256)).not.toThrow()
    expect(() => assertProductionOwnerTrust({ ...forged, kind: 'source-smoke' }, forged.sha256))
      .toThrow(/owner_artifact_not_production/)
  })
  test('accepts exact frozen refs and marker-owned capture paths', () => {
    expect(parseRuntimeManifest(manifest()).refs.orchestrator).toBe('d'.repeat(40))
  })

  test('rejects unfrozen refs, extra schema fields, and escaped paths', () => {
    const short = manifest(); short.refs.orchestrator = 'main'
    expect(() => parseRuntimeManifest(short)).toThrow(/unfrozen_ref/)
    expect(() => parseRuntimeManifest({ ...manifest(), bypass: true })).toThrow(/runtime_manifest_invalid/)
    const escaped = manifest(); escaped.capture.ownerWalTimelinePath = '/tmp/outside.ndjson'
    expect(() => parseRuntimeManifest(escaped)).toThrow(/escaped_sandbox/)
  })

  test('fails closed when the bound marker is missing', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'actual-owner-' + 'a'.repeat(48) + '-'))
    temporaryRoots.push(sandbox)
    await chmod(sandbox, 0o700)
    const input = parseRuntimeManifest({
      ...manifest(), sandboxRoot: sandbox,
      markerPath: join(sandbox, '.agent-teams-actual-owner-e2e-owner.json'),
      capture: { ...manifest().capture, ownerWalTimelinePath: join(sandbox, 'owner.ndjson') },
    })
    await expect(assertMarkerOwnedSandbox(input)).rejects.toThrow()
  })

  test('rejects an executable whose bytes do not match the admitted candidate digest', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'actual-owner-artifact-'))
    temporaryRoots.push(sandbox)
    const executable = join(sandbox, basename('opencode'))
    await writeFile(executable, 'candidate-one', { mode: 0o755 })
    await expect(assertCandidateArtifact(executable, 'f'.repeat(64)))
      .rejects.toThrow(/candidate_digest_mismatch/)
  })

  test('appends timeline records through a pinned private file and rejects final symlinks', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'actual-owner-timeline-'))
    temporaryRoots.push(sandbox)
    await chmod(sandbox, 0o700)
    const capture = join(sandbox, 'capture')
    await mkdir(capture, { mode: 0o700 })
    const timeline = join(capture, 'owner.ndjson')
    const external = `${sandbox}.outside`
    temporaryRoots.push(external)
    await writeFile(external, 'untouched', { mode: 0o600 })
    await symlink(external, timeline)
    await expect(appendPrivateTimeline(timeline, sandbox, '{"event":"attack"}\n'))
      .rejects.toThrow()
    expect(await readFile(external, 'utf8')).toBe('untouched')
    await rm(timeline)
    await appendPrivateTimeline(timeline, sandbox, '{"event":"one"}\n')
    await appendPrivateTimeline(timeline, sandbox, '{"event":"two"}\n')
    expect(await readFile(timeline, 'utf8'))
      .toBe('{"event":"one"}\n{"event":"two"}\n')
  })

  test('serializes concurrent timeline appends without failing after a durable write', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'actual-owner-timeline-concurrent-'))
    temporaryRoots.push(sandbox)
    await chmod(sandbox, 0o700)
    const capture = join(sandbox, 'capture')
    await mkdir(capture, { mode: 0o700 })
    const timeline = join(capture, 'owner.ndjson')
    const lines = Array.from({ length: 32 }, (_, index) => `{"sequence":${index}}\n`)
    await expect(Promise.all(lines.map(line => appendPrivateTimeline(timeline, sandbox, line))))
      .resolves.toHaveLength(lines.length)
    expect((await readFile(timeline, 'utf8')).split('\n').filter(Boolean).sort())
      .toEqual(lines.map(line => line.trim()).sort())
  })
})
