/** No inference. Invoke on a disposable Windows runner with public runtime binaries
 * and an npm-installed opencode-ai@1.18.31 shim. Each runtime gets a fresh profile.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

type Json = Record<string, any>
const [rootArg, shimArg, candidateArg, baselineArg] = process.argv.slice(2)
assert(process.platform === 'win32', 'This reproduction requires Windows')
assert(rootArg && shimArg && candidateArg && baselineArg, 'Expected TEST root, npm shim, candidate and baseline')
const root = await realpath(rootArg)
assert(path.basename(root).startsWith('TEST-opencode-provider-'), 'Use a dedicated TEST root')
const shim = await realpath(shimArg)
assert(shim.endsWith('.cmd'), 'Must exercise the npm .cmd selection')
const shimText = await readFile(shim, 'utf8')
assert(shimText.includes('opencode-ai'), 'Expected genuine npm OpenCode shim')

async function run(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout!.on('data', chunk => { stdout += chunk })
  child.stderr!.on('data', chunk => { stderr += chunk })
  // A timeout fails the job. The disposable runner owns final process teardown;
  // no PID-only kill or removal of a potentially live profile is attempted here.
  const timer = setTimeout(() => { console.error('TEST command deadline expired'); process.exit(1) }, 150_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve)
    })
    let value: Json | null = null
    try { value = JSON.parse(stdout) } catch { /* retain invalid output as a failure */ }
    return { code, value, stdout, stderr }
  } finally { clearTimeout(timer) }
}

async function inspect(label: string, executable: string) {
  const own = path.join(root, label)
  const dirs = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata', 'runtime-data', 'runtime-cache', 'project']
    .map(name => [name, path.join(own, name)]))
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true })))
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  Object.assign(env, {
    HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata,
    XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
    TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp, CI: '1', NO_COLOR: '1',
    CLAUDE_MULTIMODEL_DATA_HOME: dirs['runtime-data'], CLAUDE_MULTIMODEL_CACHE_HOME: dirs['runtime-cache'],
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: shim,
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    DEEPINFRA_API_KEY: 'TEST-not-a-real-key',
  })
  // Global source, not a project config or managed credential. The API endpoint
  // deliberately cannot perform inference; only catalog reads are authorized.
  const globalConfig = path.join(dirs.config!, 'opencode')
  await mkdir(globalConfig, { recursive: true })
  await writeFile(path.join(globalConfig, 'opencode.jsonc'), `// TEST global provider imported by the runtime\n${JSON.stringify({
    plugin: [], provider: { 'deep-infra': { npm: '@ai-sdk/openai-compatible',
      options: { apiKey: '{env:DEEPINFRA_API_KEY}', baseURL: 'http://127.0.0.1:1/inference-forbidden' },
      models: { 'TEST-catalog-model': { name: 'TEST imported catalog', limit: { context: 8192, output: 1024 } } },
    } },
  }, null, 2)}`)
  const responses: Record<string, Awaited<ReturnType<typeof run>>> = {}
  for (const [name, args] of [
    ['status', ['runtime', 'status', '--provider', 'opencode']],
    ['view', ['runtime', 'providers', 'view', '--runtime', 'opencode', '--project-path', dirs.project!, '--json']],
    ['models', ['runtime', 'providers', 'models', '--runtime', 'opencode', '--provider', 'deep-infra', '--project-path', dirs.project!, '--json']],
  ] as const) {
    responses[name] = await run(executable, [...args], dirs.project!, env)
    await writeFile(path.join(own, `${name}.json`), JSON.stringify(responses[name], null, 2))
  }
  const view = responses.view!.value?.view
  const models = responses.models!.value?.models
  const checks = {
    statusSucceeded: responses.status!.code === 0,
    viewSucceeded: responses.view!.code === 0,
    selectionDetected: Boolean(view?.runtime?.cliPath),
    exactVersion: view?.runtime?.version === '1.18.31',
    providerConnected: view?.providers?.some((item: Json) => item.providerId === 'deep-infra' && item.state === 'connected') === true,
    modelsLoaded: responses.models!.code === 0 && models?.models?.some((item: Json) => item.modelId === 'deep-infra/TEST-catalog-model') === true,
    noPendingIdentity: !JSON.stringify(responses).includes('capabilities_pending') && !JSON.stringify(responses).includes('Selected OpenCode identity is unavailable'),
  }
  return { label, checks, passed: Object.values(checks).every(Boolean) }
}

// Keep the baseline outcome even if it is green: process races are not required
// to reproduce on every machine. Never retry until a desired failure appears.
const baseline = await inspect('baseline-118', baselineArg)
await writeFile(path.join(root, 'baseline-summary.json'), JSON.stringify(baseline, null, 2))
const candidate = await inspect('candidate-120', candidateArg)
await writeFile(path.join(root, 'candidate-summary.json'), JSON.stringify(candidate, null, 2))
console.log(JSON.stringify({ baseline, candidate, limitations: ['CLI boundary only; no inference or original user-machine attribution. Disposable runner teardown required.'] }, null, 2))
assert(candidate.passed, 'Runtime 120 did not preserve the npm V1 global provider catalog')
