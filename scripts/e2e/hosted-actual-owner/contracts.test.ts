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
    evidenceRoot: `${root}/evidence`,
    driverBaseUrl: 'http://127.0.0.1:49152/',
    productBaseUrl: 'http://127.0.0.1:49153/',
    approvalPath: '/hosted/approvals',
    browser: {},
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
      conditionalPostLedgerPath: `${root}/capture/posts.ndjson`,
      negativeResultsPath: `${root}/capture/negative.json`,
      openCodeTimelinePath: `${root}/capture/opencode.ndjson`,
      ownerWalTimelinePath: '${SANDBOX_ROOT}/capture/owner.ndjson',
      productTimelinePath: `${root}/capture/product.ndjson`,
      protectedEffectLedgerPath: `${root}/capture/effects.json`,
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
    expect(parseRuntimeManifest(manifest()).refs.orchestrator).toBe('d'.repeat(40))
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
