import assert from 'node:assert/strict'
import { test } from 'node:test'
import { provePostMergeReuse } from './post-merge-reuse.ts'

const merge = 'a'.repeat(40), head = 'b'.repeat(40), tree = 'c'.repeat(40)
const repository = '777genius/agent_teams_orchestrator'
const context = { event: 'push', ref: 'refs/heads/main', repository, sha: merge }
const pr = { number: 7, merged_at: '2026-11-04T20:00:00Z', merge_commit_sha: merge,
  base: { ref: 'main' }, head: { sha: head } }
const check = { name: 'CI required', head_sha: head, status: 'completed', conclusion: 'success',
  app: { slug: 'github-actions' },
  details_url: `https://github.com/${repository}/actions/runs/123/job/456` }
const run = { event: 'pull_request', status: 'completed', conclusion: 'success', name: 'CI',
  path: '.github/workflows/ci.yml', head_sha: head }
function evidence(overrides: Record<string, unknown> = {}) {
  const table: Record<string, unknown> = {
    [`repos/${repository}/commits/${merge}/pulls`]: [pr],
    [`repos/${repository}/git/commits/${merge}`]: { tree: { sha: tree } },
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
    assert.equal(await provePostMergeReuse({ ...context, ...changed }, async () => { throw Error('Must not read') }), false)
  }
})
test('missing, ambiguous, unmerged or unrelated PR never grants reuse', async () => {
  const url = `repos/${repository}/commits/${merge}/pulls`
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
