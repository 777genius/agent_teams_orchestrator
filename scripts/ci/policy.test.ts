import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { aggregate, classify, diffArgs, parsePaths } from './policy.ts'

test('routine source and documentation keep Linux coverage without native jobs', () => {
  for (const path of ['src/components/Button.tsx', 'src/utils/processUserInput/processTextPrompt.ts', 'src/services/opencode/OpenCodeLogProjector.ts', 'src/services/opencode/OpenCodeModelRef.ts', 'docs/guide.md', 'src/features/runtimeProviderManagement/ui/ProviderManagementDialog.tsx']) {
    const decision = classify([path])
    assert.equal(decision.native, 'false', path)
    assert.deepEqual(JSON.parse(decision.authority_os), ['ubuntu-latest'])
    assert.match(decision.reason, /native jobs skipped/)
  }
})

test('custody, process identity, startup cleanup, lifecycle, ABI and policy retain native gates', () => {
  for (const path of ['src/services/opencode/OpenCodeBinaryResolver.ts', 'src/services/opencode/compatibility/OpenCodeVersionProbe.ts', 'src/services/opencode/compatibility/OpenCodeVersionProbe.helperBudget.test.ts', 'src/services/opencode/OpenCodeProvisioningProbe.ts', 'src/services/opencode/OpenCodeExecutionProof.ts', 'src/services/opencode/OpenCodeSelectedSessionAuthority.ts', 'src/services/opencode/OpenCodeCursorAgentAtomicReap.test.ts', 'src/services/opencode/OpenCodeStartupCleanup.ts', 'src/services/opencode/OpenCodeProcessAttributionStore.ts', 'src/services/opencode/recovery-contract/independent-boundaries.test.ts', 'src/utils/processKill.ts', 'src/utils/windowsNativeProcess.ts', 'src/utils/swarm/processBackend.ts', 'src/services/runtimeBackends/registry.ts', 'src/services/teamBootstrap/teamBootstrapRunner.ts', 'src/features/runtimeProviderManagement/application/connectProvider.ts', 'src/native-ts/yoga-layout/index.ts', 'src/entrypoints/cli.tsx', 'scripts/build.ts', 'scripts/package-runtime.ts', 'scripts/runtime-bun-pins.json', 'scripts/opencode-v2/stage.ts', 'src/cli/packagedOpenCodeDelivery.ts', 'src/cli/packagedOpenCodeDelivery.test.ts', 'package.json', 'bun.lock', 'tsconfig.json', '.github/workflows/ci.yml', 'scripts/ci/policy.test.ts', 'scripts/smoke/windows-runtime-opencode-provider-json.mjs']) {
    assert.equal(classify([path]).native, 'true', path)
    assert.deepEqual(JSON.parse(classify([path]).authority_os), ['ubuntu-latest', 'windows-latest'])
  }
  assert.equal(classify([], true).native, 'true')
})

test('event ranges distinguish PR merge base, push before/head and new branches', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40)
  assert.deepEqual(diffArgs('pull_request', base, head), ['diff', '--name-only', '-z', '--no-renames', `${base}...${head}`, '--'])
  assert.deepEqual(diffArgs('push', base, head), ['diff', '--name-only', '-z', '--no-renames', base, head, '--'])
  assert.deepEqual(diffArgs('push', '0'.repeat(40), head), ['ls-tree', '-r', '--name-only', '-z', head])
  for (const event of ['pull_request_target', '', 'workflow_dispatch']) assert.throws(() => diffArgs(event, base, head))
  assert.throws(() => diffArgs('push', '--bad-ref', head))
  assert.throws(() => diffArgs('pull_request', '0'.repeat(40), head))
})

test('effective model ownership and fixture changes retain both native authority lanes', () => {
  for (const path of [
    'src/services/runtimeBackends/effectiveDefaultModel.ts',
    'src/services/runtimeBackends/effectiveDefaultModel.test.ts',
    'src/cli/effectiveDefaultModel.entry.test.ts',
    'src/cli/runtimeStatusCommand.entry.test.ts',
    'src/cli/handlers/model.ts',
    'src/cli/handlers/model.test.ts',
    'src/cli/handlers/anthropicCompatibleRuntime.integration.test.ts',
  ]) {
    assert.equal(classify([path]).native, 'true', path)
    assert.deepEqual(
      JSON.parse(classify([path]).authority_os),
      ['ubuntu-latest', 'windows-latest'],
      path,
    )
  }
  assert.equal(classify(['src/cli/handlers/unrelated.ts']).native, 'false')
})

test('NUL records preserve old/deleted paths and unusual filenames', () => {
  const paths = parsePaths('src/services/opencode/OpenCodeHostIdentity.ts\0docs/renamed file\nTEST.md\0')
  assert.equal(paths.length, 2)
  assert.equal(classify(paths).native, 'true')
  assert.deepEqual(parsePaths(''), [])
  assert.throws(() => parsePaths('src/truncated'))
})

test('real no-index Git diff retains renamed-away and deleted authority paths', () => {
  assert.ok(process.env.TMPDIR)
  const root = mkdtempSync(join(process.env.TMPDIR, 'TEST-ci-diff-'))
  try {
    mkdirSync(join(root, 'old/src/services/opencode'), { recursive: true })
    mkdirSync(join(root, 'new/docs'), { recursive: true })
    writeFileSync(join(root, 'old/src/services/opencode/OpenCodeHostIdentity.ts'), 'TEST rename\n')
    writeFileSync(join(root, 'old/src/services/opencode/OpenCodeStartupCleanup.test.ts'), 'TEST delete\n')
    writeFileSync(join(root, 'new/docs/renamed file\nTEST.md'), 'TEST rename\n')
    // No-index name-only prints /dev/null for deletions; use its status/path
    // pairs to exercise real file changes without creating any Git metadata.
    const diff = spawnSync('git', ['diff', '--no-index', '--name-status', '-z', '--no-renames', '--', 'old', 'new'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: process.env.TMPDIR, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
    assert.equal(diff.status, 1, diff.stderr)
    const paths = parsePaths(diff.stdout).filter((_, index) => index % 2 === 1).map(path => path.replace(/^(old|new)\//, ''))
    assert.ok(paths.includes('src/services/opencode/OpenCodeHostIdentity.ts'))
    assert.ok(paths.includes('src/services/opencode/OpenCodeStartupCleanup.test.ts'))
    assert.ok(paths.includes('docs/renamed file\nTEST.md'))
    assert.equal(classify(paths).native, 'true')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function needs(native = 'false') {
  return {
    scope: { result: 'success', outputs: { native, reason: 'TEST decision' } },
    'cursor-managed-plugin': { result: 'success' },
    'task-change-ledger': { result: 'success' },
    'opencode-authority': { result: 'success' },
    'packaged-delivery': { result: native === 'true' ? 'success' : 'skipped' },
    'windows-packaged-backfill': { result: native === 'true' ? 'success' : 'skipped' },
    'opencode-conformance': { result: native === 'true' ? 'success' : 'skipped' },
  }
}

test('aggregate independently rejects required failures/cancellation/skips and classifier failures', () => {
  for (const native of ['true', 'false']) {
    assert.equal(aggregate(needs(native)), 'TEST decision')
    for (const job of Object.keys(needs(native))) {
      for (const result of ['failure', 'cancelled', 'skipped', 'unknown']) {
        const sample = needs(native)
        sample[job as keyof typeof sample].result = result
        if (native === 'false' && result === 'skipped' && ['windows-packaged-backfill', 'opencode-conformance', 'packaged-delivery'].includes(job)) {
          assert.equal(aggregate(sample), 'TEST decision')
        } else assert.throws(() => aggregate(sample), `${job}/${native}/${result}`)
      }
    }
  }
  for (const native of ['', 'invalid']) assert.throws(() => aggregate(needs(native)))
  const missingReason = needs(); missingReason.scope.outputs.reason = ''
  assert.throws(() => aggregate(missingReason))
  assert.throws(() => aggregate({}))
})

test('actual Node CLI emits outputs and fails closed without Git access or valid needs', () => {
  assert.ok(process.env.TMPDIR, 'TEST TMPDIR must be explicitly isolated')
  const root = mkdtempSync(join(process.env.TMPDIR, 'TEST-ci-policy-'))
  const helper = new URL('./policy.ts', import.meta.url)
  const invoke = (command: string, env: Record<string, string>) => spawnSync(process.execPath, [helper.pathname, command], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: process.env.TMPDIR, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env } })
  try {
    const output = join(root, 'outputs')
    const full = invoke('classify', { CI_EVENT: 'workflow_dispatch', CI_FULL: 'true', GITHUB_OUTPUT: output })
    assert.equal(full.status, 0, full.stderr)
    assert.match(readFileSync(output, 'utf8'), /native=true\nauthority_os=\["ubuntu-latest","windows-latest"\]\nreason=Explicit full validation request\n/)
    assert.notEqual(invoke('classify', { CI_EVENT: 'workflow_dispatch', CI_FULL: 'false', GITHUB_OUTPUT: output }).status, 0)
    assert.notEqual(invoke('classify', { CI_EVENT: 'push', CI_BASE: 'a'.repeat(40), CI_HEAD: 'b'.repeat(40), GITHUB_OUTPUT: output }).status, 0)
    assert.equal(invoke('aggregate', { CI_NEEDS: JSON.stringify(needs()) }).status, 0)
    const failed = needs(); failed['opencode-authority'].result = 'cancelled'
    assert.notEqual(invoke('aggregate', { CI_NEEDS: JSON.stringify(failed) }).status, 0)
    assert.notEqual(invoke('aggregate', { CI_NEEDS: 'broken JSON' }).status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
