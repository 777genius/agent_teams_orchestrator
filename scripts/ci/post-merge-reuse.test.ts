import assert from 'node:assert/strict'
import { test } from 'node:test'
import { provePostMergeReuse } from './post-merge-reuse.ts'

const merge = 'a'.repeat(40), head = 'b'.repeat(40), tree = 'c'.repeat(40), base = 'd'.repeat(40)
const repository = '777genius/agent_teams_orchestrator'
const context = { event: 'push', ref: 'refs/heads/main', repository, sha: merge }
const pr = { number: 7, merged_at: '2026-11-04T20:00:00Z', merge_commit_sha: merge,
  base: { ref: 'main', sha: base }, head: { sha: head, ref: 'feat/verified', repo: { full_name: repository } } }
const check = { id: 456, name: 'CI required', head_sha: head, status: 'completed', conclusion: 'success',
  completed_at: '2026-11-04T19:59:00Z',
  app: { slug: 'github-actions' },
  details_url: `https://github.com/${repository}/actions/runs/123/job/456` }
const run = { event: 'pull_request', status: 'completed', conclusion: 'success', name: 'CI',
  path: '.github/workflows/ci.yml', head_sha: head, updated_at: '2026-11-04T19:59:00Z',
  head_branch: pr.head.ref, head_repository: { full_name: repository },
  display_title: `CI PR=${pr.number} HEAD=${head} BASE=${base} TARGET=main`,
  pull_requests: [] }
function evidence(overrides: Record<string, unknown> = {}) {
  const table: Record<string, unknown> = {
    [`repos/${repository}/commits/${merge}/pulls?per_page=2`]: [pr],
    [`repos/${repository}/commits/${head}/pulls?per_page=2`]: [pr],
    [`repos/${repository}/git/commits/${merge}`]: { tree: { sha: tree }, parents: [{ sha: base }] },
    [`repos/${repository}/git/commits/${head}`]: { tree: { sha: tree } },
    [`repos/${repository}/commits/${head}/check-runs?check_name=CI%20required&per_page=100`]: { check_runs: [check] },
    [`repos/${repository}/actions/runs/123`]: run,
    ...overrides,
  }
  return async (route: string) => {
    if (!Object.hasOwn(table, route)) throw new Error('TEST unexpected API read')
    return table[route]
  }
}

test('only an identical merged PR tree and completed PR CI required permits reuse', async () => {
  assert.equal(await provePostMergeReuse(context, evidence()), true)
})
test('a direct push, dev push, invalid SHA or different repository must do full CI without API reads', async () => {
  for (const changed of [{ event: 'pull_request' }, { ref: 'refs/heads/dev' }, { sha: 'bad' },
    { repository: 'another/repo' }]) {
    let calls = 0
    assert.equal(await provePostMergeReuse({ ...context, ...changed }, async () => {
      calls++
      throw Error('Must not read')
    }), false)
    assert.equal(calls, 0)
  }
})
test('missing, ambiguous, unmerged or unrelated PR never grants reuse', async () => {
  const url = `repos/${repository}/commits/${merge}/pulls?per_page=2`
  for (const prs of [[], [pr, pr], [{ ...pr, merged_at: null }], [{ ...pr, merge_commit_sha: head }],
    [{ ...pr, base: { ref: 'dev' } }]]) {
    assert.equal(await provePostMergeReuse(context, evidence({ [url]: prs })), false)
  }
})
test('merge conflict resolution, a different PR head tree and read failures all demand full CI', async () => {
  const url = `repos/${repository}/git/commits/${head}`
  assert.equal(await provePostMergeReuse(context, evidence({ [url]: { tree: { sha: 'd'.repeat(40) } } })), false)
  assert.equal(await provePostMergeReuse(context, async () => { throw Error('API offline') }), false)
})
test('a skipped, pending or foreign-app check never permits reuse', async () => {
  const url = `repos/${repository}/commits/${head}/check-runs?check_name=CI%20required&per_page=100`
  for (const candidate of [{ ...check, conclusion: 'skipped' }, { ...check, status: 'queued', conclusion: null },
    { ...check, app: { slug: 'third-party' } }, { ...check, head_sha: merge },
    { ...check, details_url: 'https://example.com/foreign' }]) {
    assert.equal(await provePostMergeReuse(context, evidence({ [url]: { check_runs: [candidate] } })), false)
  }
})
test('a cancelled, non-PR, wrong-head or other workflow run is not a PR CI proof', async () => {
  const url = `repos/${repository}/actions/runs/123`
  for (const changed of [{ conclusion: 'cancelled' }, { event: 'workflow_dispatch' },
    { head_sha: merge }, { path: '.github/workflows/manual.yml' }, { status: 'in_progress' }]) {
    assert.equal(await provePostMergeReuse(context, evidence({ [url]: { ...run, ...changed } })), false)
  }
})

test('a newer failed or queued gate cannot be bypassed using stale successful checks', async () => {
  const url = `repos/${repository}/commits/${head}/check-runs?check_name=CI%20required&per_page=100`
  for (const newer of [{ ...check, id: 457, conclusion: 'failure' },
    { ...check, id: 458, status: 'queued', conclusion: null }]) {
    assert.equal(await provePostMergeReuse(context, evidence({ [url]: { check_runs: [check, newer] } })), false)
  }
})

test('a completed GitHub PR run with an empty pull_requests list still uses unambiguous head provenance', async () => {
  assert.equal(await provePostMergeReuse(context, evidence()), true)
  const url = `repos/${repository}/actions/runs/123`
  for (const changed of [
    { pull_requests: [{ number: pr.number + 1 }] },
    { pull_requests: [{ number: pr.number }, { number: pr.number + 1 }] },
    { pull_requests: null },
    { head_branch: 'another-branch' },
    { head_repository: { full_name: 'another/repository' } },
    { display_title: `CI PR=${pr.number} HEAD=${head} BASE=${base} TARGET=dev` },
    { display_title: `CI PR=${pr.number + 1} HEAD=${head} BASE=${base} TARGET=main` },
    { display_title: `CI PR=${pr.number} HEAD=${head} BASE=${'e'.repeat(40)} TARGET=main` },
    { display_title: '' },
  ]) {
    assert.equal(await provePostMergeReuse(context, evidence({ [url]: { ...run, ...changed } })), false)
  }
})

test('another, missing or ambiguous PR at the exact head must always force full CI', async () => {
  const url = `repos/${repository}/commits/${head}/pulls?per_page=2`
  for (const pulls of [
    [], [pr, pr], [{ ...pr, number: pr.number + 1 }],
    [{ ...pr, head: { ...pr.head, ref: 'another-branch' } }],
    [{ ...pr, head: { ...pr.head, repo: { full_name: 'another/repository' } } }],
  ]) {
    assert.equal(await provePostMergeReuse(context, evidence({ [url]: pulls })), false)
  }
})

test('qualifying CI must be complete before the merge, not afterwards', async () => {
  const checks = `repos/${repository}/commits/${head}/check-runs?check_name=CI%20required&per_page=100`
  assert.equal(await provePostMergeReuse(context, evidence({ [checks]: {
    check_runs: [{ ...check, completed_at: '2026-11-04T20:01:00Z' }],
  } })), false)
  assert.equal(await provePostMergeReuse(context, evidence({ [`repos/${repository}/actions/runs/123`]: {
    ...run, updated_at: '2026-11-04T20:01:00Z',
  } })), false)
})

test('merged base must match the first parent, even if the PR head tree matches', async () => {
  const url = `repos/${repository}/git/commits/${merge}`
  assert.equal(await provePostMergeReuse(context, evidence({
    [url]: { tree: { sha: tree }, parents: [{ sha: 'e'.repeat(40) }] },
  })), false)
})
