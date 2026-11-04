import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type Read = (route: string) => Promise<unknown>
type Context = { event: string; ref: string; repository: string; sha: string }
const hexSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const fields = (value: unknown, key: string) => object(value)[key]

/** Fail closed: no source reuse without a merged PR, identical tree and successful PR CI. */
export async function provePostMergeReuse(context: Context, read: Read): Promise<boolean> {
  if (context.event !== 'push' || context.ref !== 'refs/heads/main' ||
    context.repository !== '777genius/agent_teams_orchestrator' || !hexSha(context.sha)) return false
  const root = `repos/${context.repository}`
  try {
    const associated = await read(`${root}/commits/${context.sha}/pulls?per_page=2`)
    if (!Array.isArray(associated) || associated.length !== 1) return false
    const pr = object(associated[0]), source = fields(pr, 'head')
    const head = fields(source, 'sha')
    const baseSha = fields(pr.base, 'sha')
    const headBranch = fields(source, 'ref')
    const headRepository = fields(fields(source, 'repo'), 'full_name')
    if (!hexSha(head) || !hexSha(baseSha) || pr.merge_commit_sha !== context.sha ||
      typeof pr.merged_at !== 'string' || fields(pr.base, 'ref') !== 'main' ||
      typeof headBranch !== 'string' || !headBranch ||
      typeof headRepository !== 'string' || !headRepository) return false
    // GitHub omits workflow_run.pull_requests after some real merges. Resolve
    // the exact head's own PR association independently instead of trusting
    // an empty list or borrowing a successful run from a different PR.
    const headAssociated = await read(`${root}/commits/${head}/pulls?per_page=2`)
    if (!Array.isArray(headAssociated) || headAssociated.length !== 1 ||
      fields(headAssociated[0], 'number') !== pr.number ||
      fields(fields(headAssociated[0], 'head'), 'sha') !== head ||
      fields(fields(headAssociated[0], 'head'), 'ref') !== headBranch ||
      fields(fields(fields(headAssociated[0], 'head'), 'repo'), 'full_name') !== headRepository ||
      fields(fields(headAssociated[0], 'base'), 'ref') !== 'main' ||
      fields(headAssociated[0], 'merge_commit_sha') !== context.sha) return false
    const [merged, original] = await Promise.all([
      read(`${root}/git/commits/${context.sha}`), read(`${root}/git/commits/${head}`),
    ])
    const tree = fields(fields(merged, 'tree'), 'sha')
    const parents = fields(merged, 'parents')
    if (!hexSha(tree) || tree !== fields(fields(original, 'tree'), 'sha') ||
      !Array.isArray(parents) || !parents.length || fields(parents[0], 'sha') !== baseSha) return false
    const checks = fields(await read(`${root}/commits/${head}/check-runs?check_name=CI%20required&per_page=100`), 'check_runs')
    if (!Array.isArray(checks)) return false
    const candidates = checks.map(object).filter(check => check.name === 'CI required' && check.head_sha === head)
    if (!candidates.length || candidates.some(check => !Number.isSafeInteger(check.id) || Number(check.id) <= 0)) return false
    // Only the most recent required gate for this head is authoritative.
    const check = candidates.sort((a, b) => Number(b.id) - Number(a.id))[0]
    const url = check.details_url
    const finishedBeforeMerge = (value: unknown): boolean =>
      typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
      Date.parse(value) <= Date.parse(String(pr.merged_at))
    if (check.status !== 'completed' || check.conclusion !== 'success' ||
      fields(check.app, 'slug') !== 'github-actions' || typeof url !== 'string' ||
      !finishedBeforeMerge(check.completed_at)) return false
    const match = /^https:\/\/github\.com\/777genius\/agent_teams_orchestrator\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)$/.exec(url)
    if (!match) return false
    const run = object(await read(`${root}/actions/runs/${match[1]}`))
    // GitHub may empty run.pull_requests after merge. An empty list proves
    // nothing: require the server-evaluated PR number, head, base and target
    // in the workflow run title (plus the frozen merge-parent base).
    const runPulls = fields(run, 'pull_requests')
    const expectedTitle = `CI PR=${pr.number} HEAD=${head} BASE=${baseSha} TARGET=main`
    const samePr = Number.isSafeInteger(pr.number) && Array.isArray(runPulls) &&
      (runPulls.length === 0 || (runPulls.length === 1 && fields(runPulls[0], 'number') === pr.number)) &&
      run.display_title === expectedTitle && run.head_branch === headBranch &&
      fields(run.head_repository, 'full_name') === headRepository
    return samePr && run.event === 'pull_request' && run.status === 'completed' && run.conclusion === 'success' &&
      run.name === expectedTitle && run.path === '.github/workflows/ci.yml' && run.head_sha === head &&
      finishedBeforeMerge(run.updated_at)
  } catch { /* API errors and unavailable evidence always fall back to full CI. */ }
  return false
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const context: Context = { event: process.env.GITHUB_EVENT_NAME ?? '', ref: process.env.GITHUB_REF ?? '',
    repository: process.env.GITHUB_REPOSITORY ?? '', sha: process.env.GITHUB_SHA ?? '' }
  const read: Read = async route => {
    if (!process.env.GH_TOKEN) throw new Error('Missing read-only GitHub token')
    const response = await fetch(new URL(`/${route}`, process.env.GITHUB_API_URL ?? 'https://api.github.com'), {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(`GitHub read failed: ${response.status}`)
    return response.json()
  }
  const reuse = await provePostMergeReuse(context, read)
  if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GitHub step output file')
  appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${reuse}\n`)
  console.log(reuse ? 'Identical merged PR tree with completed CI required: fast post-merge smoke' :
    'No complete same-tree PR CI proof: full validation required')
}
