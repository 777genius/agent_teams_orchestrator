import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import recorded from './BaseVsWipEvidence.json'
import {
  artifactSha256,
  CANONICAL_ACCEPTANCE_BASE,
  REVIEWED_LATEST_COMMIT,
  REVIEWED_LATEST_TREE,
  validateBaseVsHeadIdentity,
  type BaseVsHeadIdentity,
} from './BaseVsWipEvidence.js'

const root = path.resolve(import.meta.dir, '..')
const git = '/usr/bin/git'

async function run(args: string[], cwd = root): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([git, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  return { code, stdout, stderr }
}

async function checked(args: string[], cwd = root): Promise<string> {
  const result = await run(args, cwd)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function captureIdentity(): Promise<BaseVsHeadIdentity> {
  const headRevision = await checked(['rev-parse', 'HEAD'])
  const headTree = await checked(['rev-parse', 'HEAD^{tree}'])
  const changedFiles = (await checked(['diff', '--name-only', `${CANONICAL_ACCEPTANCE_BASE}...HEAD`]))
    .split('\n').filter(Boolean)
  const patch = await checked(['diff', '--binary', '--no-ext-diff', `${CANONICAL_ACCEPTANCE_BASE}...HEAD`])
  return {
    schema: 3,
    baseRevision: recorded.baseRevision,
    reviewedLatestCommit: recorded.reviewedLatestCommit,
    reviewedLatestTree: recorded.reviewedLatestTree,
    observedReviewedTree: await checked(['rev-parse', `${REVIEWED_LATEST_COMMIT}^{tree}`]),
    headRevision,
    observedHeadRevision: headRevision,
    headTree,
    observedHeadTree: headTree,
    mergeBase: await checked(['merge-base', CANONICAL_ACCEPTANCE_BASE, 'HEAD']),
    reviewedIsAncestor: (await run(['merge-base', '--is-ancestor', REVIEWED_LATEST_COMMIT, 'HEAD'])).code === 0,
    commitCount: Number(await checked(['rev-list', '--count', `${CANONICAL_ACCEPTANCE_BASE}..HEAD`])),
    committedPatchBytes: new TextEncoder().encode(patch).byteLength,
    changedFiles,
  }
}

test('binds canonical base through reviewed latest tree to an exact non-empty committed production HEAD artifact', async () => {
  const identity = await captureIdentity()
  expect(() => validateBaseVsHeadIdentity(identity)).not.toThrow()
  expect(artifactSha256(identity)).toMatch(/^[0-9a-f]{64}$/)
  expect(identity.changedFiles.some(file => file.startsWith('src/'))).toBe(true)
})

describe('BaseVsWip fail-closed negative matrix', () => {
  const valid = (): BaseVsHeadIdentity => ({
    schema: 3, baseRevision: CANONICAL_ACCEPTANCE_BASE,
    reviewedLatestCommit: REVIEWED_LATEST_COMMIT, reviewedLatestTree: REVIEWED_LATEST_TREE,
    observedReviewedTree: REVIEWED_LATEST_TREE,
    headRevision: '1'.repeat(40), observedHeadRevision: '1'.repeat(40),
    headTree: '2'.repeat(40), observedHeadTree: '2'.repeat(40),
    mergeBase: CANONICAL_ACCEPTANCE_BASE, reviewedIsAncestor: true,
    commitCount: 2, committedPatchBytes: 100,
    changedFiles: ['src/services/opencode/OpenCodeLaunchAttemptProductionComposition.ts'],
  })

  test.each([
    ['empty committed diff despite a working-tree-only patch', { commitCount: 0, committedPatchBytes: 0 }],
    ['unrelated committed diff', { changedFiles: ['README.md'] }],
    ['wrong tree', { observedHeadTree: '3'.repeat(40) }],
    ['wrong reviewed tree', { observedReviewedTree: '3'.repeat(40) }],
    ['wrong HEAD', { observedHeadRevision: '4'.repeat(40) }],
    ['wrong base', { baseRevision: '5'.repeat(40) }],
    ['facade-only change', { changedFiles: ['phase0-opencode-tests/PortableOpenCodeAcceptanceHarness.ts'] }],
    ['production composer bypass', { changedFiles: ['src/services/opencode/OpenCodeDiagnostics.ts'] }],
  ] as const)('rejects %s', (_name, mutation) => {
    expect(() => validateBaseVsHeadIdentity({ ...valid(), ...mutation })).toThrow()
  })

  test('does not require a dirty worktree', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'opencode-clean-evidence-'))
    try {
      await mkdir(path.join(temp, 'empty'))
      const identity = valid()
      expect(() => validateBaseVsHeadIdentity(identity)).not.toThrow()
    } finally { await rm(temp, { recursive: true, force: true }) }
  })
})
