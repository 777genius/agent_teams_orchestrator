import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { assertCandidateArtifact, assertMarkerOwnedSandbox, assertRuntimeDescriptors,
  parseRuntimeManifest } from './contracts.js'

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
    sandboxRoot: '${SANDBOX_ROOT}',
    markerPath: '${SANDBOX_ROOT}/.agent-teams-actual-owner-e2e-owner.json',
    ownerWalTimelineRawPath: '${SANDBOX_ROOT}/capture/owner.ndjson',
    evidenceRoot: `${root}/evidence`,
    driverBaseUrl: 'http://127.0.0.1:49152/',
    productBaseUrl: 'http://127.0.0.1:49153/',
    approvalPath: '/hosted/approvals',
    capabilityEndpoint: 'http://127.0.0.1:49152/v1/capability',
    ownerBinding: { ownerUid: 1000, ownerSessionId: `session_${'a'.repeat(48)}`,
      ownerTokenSha256: 'f'.repeat(64) },
    socketIdentity: {
      driverSocket: { endpoint: '127.0.0.1:49152', device: '1', inode: '10' },
      productSocket: { endpoint: '127.0.0.1:49153', device: '1', inode: '11' },
    },
    contract: { path: '${SANDBOX_ROOT}/contract.json', sha256: 'f'.repeat(64), byteCount: 42,
      device: '1', inode: '3', mode: '256', sourceCommit: 'e'.repeat(40),
      repositoryPath: 'scripts/e2e/hosted-actual-owner/actual-owner-contract.v1.json' },
    browser: {
      ownerStorageStatePath: '${SANDBOX_ROOT}/browser/owner.json',
      nonOwnerStorageStatePath: '${SANDBOX_ROOT}/browser/non-owner.json',
      tracePath: '${SANDBOX_ROOT}/browser/trace.zip',
      resultsPath: '${SANDBOX_ROOT}/capture/browser-results.json',
    },
    descriptors: {
      sandboxRoot: descriptor('${SANDBOX_ROOT}', root),
      productRoot: descriptor('${PRODUCT_ROOT}', '/opt/agent-teams-product'),
      orchestratorRoot: descriptor('${ORCHESTRATOR_ROOT}', '/opt/agent-teams-orchestrator'),
      openCodeExecutable: {
        ...descriptor('${OPENCODE_EXECUTABLE}', '/opt/opencode/bin/opencode'),
        size: '42', sha256: 'c'.repeat(64),
      },
    },
    capture: {
      browserResultsPath: '${SANDBOX_ROOT}/capture/browser-results.json',
      conditionalPostLedgerPath: '${SANDBOX_ROOT}/capture/posts.ndjson',
      negativeResultsPath: '${SANDBOX_ROOT}/capture/negative.json',
      openCodeTimelinePath: '${SANDBOX_ROOT}/capture/opencode.ndjson',
      ownerWalTimelinePath: '${SANDBOX_ROOT}/capture/owner.ndjson',
      productTimelinePath: '${SANDBOX_ROOT}/capture/product.ndjson',
      protectedEffectLedgerPath: '${SANDBOX_ROOT}/capture/effects.json',
    },
    refs: {
      openCode: 'b'.repeat(40), openCodeExecutableSha256: 'c'.repeat(64),
      orchestrator: 'd'.repeat(40), product: 'e'.repeat(40),
    },
  }
}

function descriptor(token: string, path: string) {
  return { token, path, device: '1', inode: '2', mode: '493', uid: '1000' }
}

describe('hosted actual-owner acceptance preconditions', () => {
  test('accepts exact frozen refs and marker-owned capture paths', () => {
    const parsed = parseRuntimeManifest(manifest())
    expect(parsed.refs.orchestrator).toBe('d'.repeat(40))
    expect(parsed.ownerWalTimelineRawPath).toBe(`${root}/capture/owner.ndjson`)
    expect(Object.keys(parsed.capture)).toHaveLength(7)
    expect('ownerWalTimelineRawPath' in parsed.capture).toBe(false)
    const aliased = manifest()
    aliased.socketIdentity.productSocket.device = aliased.socketIdentity.driverSocket.device
    aliased.socketIdentity.productSocket.inode = aliased.socketIdentity.driverSocket.inode
    expect(() => parseRuntimeManifest(aliased)).toThrow(/runtime_manifest_binding_invalid/)
    const sameEndpoint = manifest()
    sameEndpoint.socketIdentity.productSocket.endpoint = sameEndpoint.socketIdentity.driverSocket.endpoint
    expect(() => parseRuntimeManifest(sameEndpoint)).toThrow(/runtime_manifest_binding_invalid/)
  })

  test('rejects unfrozen refs, extra schema fields, and escaped paths', () => {
    const short = manifest(); short.refs.orchestrator = 'main'
    expect(() => parseRuntimeManifest(short)).toThrow(/unfrozen_ref/)
    expect(() => parseRuntimeManifest({ ...manifest(), bypass: true })).toThrow(/runtime_manifest_invalid/)
    const escaped = manifest(); escaped.capture.ownerWalTimelinePath = '/tmp/outside.ndjson'
    expect(() => parseRuntimeManifest(escaped)).toThrow(/descriptor_binding_invalid/)
    const generic = manifest(); generic.descriptors.productRoot.token = '/opt/product'
    expect(() => parseRuntimeManifest(generic)).toThrow(/descriptor_token_invalid/)
  })

  test('fails closed when the bound marker is missing', async () => {
    const sandbox = await mkdtemp('/tmp/actual-owner-' + 'a'.repeat(48) + '-')
    temporaryRoots.push(sandbox)
    await chmod(sandbox, 0o700)
    const input = parseRuntimeManifest({
      ...manifest(),
      ownerWalTimelineRawPath: '${SANDBOX_ROOT}/owner.ndjson',
      descriptors: { ...manifest().descriptors,
        sandboxRoot: descriptor('${SANDBOX_ROOT}', sandbox) },
      capture: { ...manifest().capture, ownerWalTimelinePath: '${SANDBOX_ROOT}/owner.ndjson' },
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

  test('rejects manifest-declared descriptor identity drift', async () => {
    const sandbox = await mkdtemp('/tmp/actual-owner-descriptors-')
    temporaryRoots.push(sandbox)
    await chmod(sandbox, 0o700)
    const product = join(sandbox, 'product'); const orchestrator = join(sandbox, 'orchestrator')
    await mkdir(product, { mode: 0o700 }); await mkdir(orchestrator, { mode: 0o700 })
    const executable = join(sandbox, 'opencode')
    await writeFile(executable, 'candidate', { mode: 0o700 })
    const describe = async (token: string, path: string) => {
      const stat = await lstat(path, { bigint: true })
      return { token, path, device: stat.dev.toString(), inode: stat.ino.toString(),
        mode: (stat.mode & 0o777n).toString(), uid: stat.uid.toString() }
    }
    const executableStat = await lstat(executable, { bigint: true })
    const parsed = parseRuntimeManifest({
      ...manifest(), descriptors: {
        sandboxRoot: await describe('${SANDBOX_ROOT}', sandbox),
        productRoot: await describe('${PRODUCT_ROOT}', product),
        orchestratorRoot: await describe('${ORCHESTRATOR_ROOT}', orchestrator),
        openCodeExecutable: { ...await describe('${OPENCODE_EXECUTABLE}', executable),
          size: executableStat.size.toString(), sha256: 'c'.repeat(64) },
      },
    })
    await expect(assertRuntimeDescriptors(parsed)).resolves.toBeUndefined()
    await chmod(product, 0o755)
    await expect(assertRuntimeDescriptors(parsed)).rejects.toThrow(/descriptor_identity_mismatch/)
  })
})
