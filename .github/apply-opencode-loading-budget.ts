// Temporary, exact-source authoring helper. Removed from the candidate tree;
// it never commits, updates refs, merges PRs or changes published assets.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const repository = '777genius/agent_teams_orchestrator'
const branch = 'refs/heads/fix/opencode-three-minute-loading'
assert.equal(process.env.GITHUB_REPOSITORY, repository)
assert.equal(process.env.GITHUB_REF, branch)
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const ephemeral = ['.github/apply-opencode-loading-budget.ts', '.github/workflows/opencode-loading-budget-authoring.yml']
const changed: string[] = []
function edit(file: string, replacements: readonly (readonly [string, string])[], imported?: string) {
  let content = readFileSync(file, 'utf8')
  for (const [before, after] of replacements) {
    assert.equal(content.split(before).length - 1, 1, `Expected exactly one reviewed fragment in ${file}: ${before}`)
    content = content.replace(before, after)
  }
  if (imported) { assert(!content.includes(imported)); content = imported + '\n' + content }
  writeFileSync(file, content)
  changed.push(file)
}
if (!process.argv.includes('--publish-tree')) {
  assert.equal(git('rev-parse', 'HEAD^'), 'e36564e0ca48faa6b6a1a810208dba4c55f8ee33')
  edit('src/services/opencode/host/OpenCodeHostNativeAdapter.ts', [
    ['Math.min(30_000, context.remainingMs?.() ?? 30_000)', 'Math.min(OPEN_CODE_LOADING_TIMEOUT_MS, context.remainingMs?.() ?? OPEN_CODE_LOADING_TIMEOUT_MS)'],
  ], "import { OPEN_CODE_LOADING_TIMEOUT_MS } from '../OpenCodeLoadingBudget.js'")
  edit('src/entrypoints/opencodeV2Server.ts', [
    ['setTimeout(() => { void close() }, 30_000)', 'setTimeout(() => { void close() }, OPEN_CODE_LOADING_TIMEOUT_MS)'],
  ], "import { OPEN_CODE_LOADING_TIMEOUT_MS } from '../services/opencode/OpenCodeLoadingBudget.js'")
  edit('src/services/opencode/catalog/OpenCodeV2InventoryService.ts', [
    ['Math.min(60_000, context.remainingMs?.() ?? 60_000)', 'Math.min(OPEN_CODE_LOADING_TIMEOUT_MS, context.remainingMs?.() ?? OPEN_CODE_LOADING_TIMEOUT_MS)'],
  ], "import { OPEN_CODE_LOADING_TIMEOUT_MS } from '../OpenCodeLoadingBudget.js'")
  edit('src/services/opencode/transport/OpenCodeBoundedFetch.ts', [
    ['context.remainingMs?.() ?? 60_000', 'context.remainingMs?.() ?? OPEN_CODE_LOADING_TIMEOUT_MS'],
    ['Math.min(60_000, remaining)', 'Math.min(OPEN_CODE_LOADING_TIMEOUT_MS, remaining)'],
    ["    const initialization = activation || url.pathname === '/api/location' || url.pathname === '/api/integration'\n    const timer = setTimeout(() => controller.abort(), Math.min(initialization ? 30_000 : 15_000, this.deadline - Date.now()))", "    // All permitted routes are catalog reads (or the no-payload activation barrier).\n    // Keep one shared deadline instead of a shorter per-request loading ceiling.\n    const timer = setTimeout(() => controller.abort(), Math.min(this.deadline - Date.now(), this.context.remainingMs?.() ?? Infinity))"],
  ], "import { OPEN_CODE_LOADING_TIMEOUT_MS } from '../OpenCodeLoadingBudget.js'")
  edit('src/services/opencode/OpenCodeInventoryService.ts', [
    ['export const OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS = 180_000', 'export const OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS = OPEN_CODE_LOADING_TIMEOUT_MS'],
    ['export const OPEN_CODE_MODEL_LIST_TIMEOUT_MS = 30_000', 'export const OPEN_CODE_MODEL_LIST_TIMEOUT_MS = OPEN_CODE_LOADING_TIMEOUT_MS'],
    ['const OPEN_CODE_MANAGED_PLUGIN_FIRST_LOAD_TIMEOUT_MS = 45_000', 'const OPEN_CODE_MANAGED_PLUGIN_FIRST_LOAD_TIMEOUT_MS = OPEN_CODE_LOADING_TIMEOUT_MS'],
  ], "import { OPEN_CODE_LOADING_TIMEOUT_MS } from './OpenCodeLoadingBudget.js'")
  edit('src/features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.ts', [
    ['this.deps.viewTimeoutMs ?? 75_000', 'this.deps.viewTimeoutMs ?? OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS'],
    ['const OPEN_CODE_PROVIDER_MANAGEMENT_HOST_HEALTH_TIMEOUT_MS = 10_000', 'const OPEN_CODE_PROVIDER_MANAGEMENT_HOST_HEALTH_TIMEOUT_MS = OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS'],
  ])
  edit('src/services/opencode/OpenCodeHostManager.ts', [
    ['const OPEN_CODE_HOST_HEALTH_TIMEOUT_MS = 30_000', 'const OPEN_CODE_HOST_HEALTH_TIMEOUT_MS = OPEN_CODE_LOADING_TIMEOUT_MS'],
    ['const OPEN_CODE_HOST_HEALTH_TIMEOUT_MAX_MS = 60_000', 'const OPEN_CODE_HOST_HEALTH_TIMEOUT_MAX_MS = OPEN_CODE_LOADING_TIMEOUT_MS'],
  ], "import { OPEN_CODE_LOADING_TIMEOUT_MS } from './OpenCodeLoadingBudget.js'")
  edit('src/services/opencode/OpenCodeClientFactory.ts', [
    ['export const OPEN_CODE_INSTANCE_INITIALIZATION_TIMEOUT_MS = 30_000', 'export const OPEN_CODE_INSTANCE_INITIALIZATION_TIMEOUT_MS = OPEN_CODE_LOADING_TIMEOUT_MS'],
  ], "import { OPEN_CODE_LOADING_TIMEOUT_MS } from './OpenCodeLoadingBudget.js'")
  edit('src/services/opencode/execution/OpenCodeV2ExecutionContracts.ts', [
    ["return platform === 'win32' ? 300_000 : platform === 'darwin' ? 300_000 : 90_000", "return platform === 'win32' || platform === 'darwin' ? 300_000 : OPEN_CODE_LOADING_TIMEOUT_MS"],
  ], "import { OPEN_CODE_LOADING_TIMEOUT_MS } from '../OpenCodeLoadingBudget.js'")
  edit('src/services/opencode/bridge/OpenCodeV2RunOwner.ts', [
    ["process.platform === 'darwin' ? OPEN_CODE_V2_RUN_INITIALIZATION_MS : 30_000", 'OPEN_CODE_V2_RUN_INITIALIZATION_MS'],
  ])
  edit('src/entrypoints/opencodeV2ExecutionServer.ts', [
    ["process.platform === 'win32' ? 120_000 : 60_000", 'openCodeV2RunInitializationMs(process.platform)'],
  ])
  edit('src/services/opencode/execution/OpenCodeV2ActivationDeadline.test.ts', [
    ['Linux allows 90s:', 'Linux allows 180s:'],
  ])
  edit('.github/workflows/ci.yml', [
    ['run: bun test src/cli/packagedOpenCodeDelivery.test.ts', 'run: bun test src/services/opencode/OpenCodeLoadingBudget.test.ts src/services/opencode/host/OpenCodeHostNativeAdapter.loading.test.ts src/services/opencode/transport/OpenCodeBoundedFetch.loading.test.ts src/cli/packagedOpenCodeDelivery.test.ts'],
  ])
  writeFileSync('loading-budget-files.json', JSON.stringify(changed))
  execFileSync('git', ['diff', '--check'], { stdio: 'inherit' })
  console.log('Applied exact reviewed replacements to ' + changed.length + ' files')
} else {
  const paths: string[] = JSON.parse(readFileSync('loading-budget-files.json', 'utf8'))
  assert.equal(paths.length, 13)
  const actual = git('diff', '--name-only').split('\n').filter(Boolean).sort()
  assert.deepEqual(actual, [...paths].sort(), 'Unexpected changes outside the reviewed patch')
  async function post(route: string, body: unknown): Promise<{ sha: string }> {
    const response = await fetch(`https://api.github.com/repos/${repository}/git/${route}`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    })
    assert(response.ok, `Git object upload failed: ${response.status}`)
    const value = await response.json() as { sha: string }
    assert.match(value.sha, /^[a-f0-9]{40}$/)
    return value
  }
  const entries: { path: string; mode: string; type: string; sha: string | null }[] = []
  for (const file of paths) {
    const blob = await post('blobs', { content: readFileSync(file, 'utf8'), encoding: 'utf-8' })
    entries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
  }
  for (const file of ephemeral) entries.push({ path: file, mode: '100644', type: 'blob', sha: null })
  const tree = await post('trees', { base_tree: git('rev-parse', 'HEAD^{tree}'), tree: entries })
  const receipt = { parent: git('rev-parse', 'HEAD'), candidateTree: tree.sha, sourceBase: 'e36564e0ca48faa6b6a1a810208dba4c55f8ee33', changed: paths, removedAuthoringFiles: ephemeral }
  writeFileSync('candidate-tree.json', JSON.stringify(receipt, null, 2) + '\n')
  writeFileSync('candidate.patch', execFileSync('git', ['diff'], { encoding: 'utf8' }))
  console.log(JSON.stringify(receipt))
}
