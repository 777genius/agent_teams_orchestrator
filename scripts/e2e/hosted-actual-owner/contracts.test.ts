import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { assertCandidateArtifact, assertMarkerOwnedSandbox, parseRuntimeManifest } from './contracts.js'

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
    const sandbox = await mkdtemp('/tmp/actual-owner-' + 'a'.repeat(48) + '-')
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
    const sandbox = await mkdtemp('/tmp/actual-owner-artifact-')
    temporaryRoots.push(sandbox)
    const executable = join(sandbox, basename('opencode'))
    await writeFile(executable, 'candidate-one', { mode: 0o755 })
    await expect(assertCandidateArtifact(executable, 'f'.repeat(64)))
      .rejects.toThrow(/candidate_digest_mismatch/)
  })
})
