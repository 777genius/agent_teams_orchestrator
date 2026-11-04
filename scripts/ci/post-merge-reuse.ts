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
    const associated = await read(`${root}/commits/${context.sha}/pulls`)
    if (!Array.isArray(associated) || associated.length !== 1) return false
    const pr = object(associated[0]), source = fields(pr, 'head')
    const head = fields(source, 'sha')
    if (!hexSha(head) || pr.merge_commit_sha !== context.sha ||
      typeof pr.merged_at !== 'string' || fields(pr.base, 'ref') !== 'main') return false
    const [merged, original] = await Promise.all([
      read(`${root}/git/commits/${context.sha}`), read(`${root}/git/commits/${head}`),
    ])
    const tree = fields(fields(merged, 'tree'), 'sha')
    if (!hexSha(tree) || tree !== fields(fields(original, 'tree'), 'sha')) return false
    const runs = fields(await read(`${root}/commits/${head}/check-runs?check_name=CI%20required&per_page=100`), 'check_runs')
    if (!Array.isArray(runs)) return false
    for (const entry of runs) {
      const check = object(entry), url = check.details_url
      if (check.name !== 'CI required' || check.status !== 'completed' ||
        check.conclusion !== 'success' || check.head_sha !== head ||
        fields(check.app, 'slug') !== 'github-actions' || typeof url !== 'string') continue
      const match = /^https:\/\/github\.com\/777genius\/agent_teams_orchestrator\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)$/.exec(url)
      if (!match) continue
      const run = object(await read(`${root}/actions/runs/${match[1]}`))
      if (run.event === 'pull_request' && run.status === 'completed' && run.conclusion === 'success' &&
        run.name === 'CI' && run.path === '.github/workflows/ci.yml' && run.head_sha === head) return true
    }
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
