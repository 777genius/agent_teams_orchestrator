/** No inference. Invoke on a disposable Windows runner with a candidate runtime
 * built from source, a public baseline runtime and npm-installed opencode-ai.
 * The selected identity must survive an idle host and CPU contention, which
 * slowed every PowerShell/WMI identity helper beyond the probe deadline, and
 * the idle catalog must load.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

type Json = Record<string, any>
const [rootArg, shimArg, nativeArg, candidateArg, baselineArg] = process.argv.slice(2)
assert(process.platform === 'win32', 'This e2e requires Windows')
assert(rootArg && shimArg && nativeArg && candidateArg && baselineArg,
  'Expected TEST root, npm shim, native exe, candidate and baseline')
const root = await realpath(rootArg)
assert(path.basename(root).startsWith('TEST-opencode-identity-'), 'Use a dedicated TEST root')
const selections = { shim: await realpath(shimArg), native: await realpath(nativeArg) }
assert(selections.shim.endsWith('.cmd') && (await readFile(selections.shim, 'utf8')).includes('opencode-ai'), 'Expected genuine npm shim')
const runtimes = { candidate: await realpath(candidateArg), baseline: await realpath(baselineArg) }

async function run(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const started = performance.now()
  const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout!.on('data', chunk => { stdout += chunk })
  child.stderr!.on('data', chunk => { stderr += chunk })
  // A timeout fails the job. The disposable runner owns final process teardown.
  const timer = setTimeout(() => { console.error('TEST command deadline expired'); process.exit(1) }, 240_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve)
    })
    let value: Json | null = null
    try { value = JSON.parse(stdout) } catch { /* retain invalid output as a failure */ }
    return { code, ms: Math.round(performance.now() - started), value, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) }
  } finally { clearTimeout(timer) }
}

async function models(label: string, runtime: string, selection: string) {
  const own = path.join(root, label)
  const dirs = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata',
    'runtime-data', 'runtime-cache', 'project'].map(name => [name, path.join(own, name)]))
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
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: selection,
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  })
  // The user's failing command: the public OpenCode Zen catalog, without inference.
  const result = await run(runtime, ['runtime', 'providers', 'models', '--runtime', 'opencode', '--provider', 'opencode', '--json'],
    dirs.project!, env)
  await writeFile(path.join(own, 'models.json'), JSON.stringify(result, null, 2))
  const message = String(result.value?.error?.message ?? '')
  return {
    label, code: result.code, ms: result.ms, errorCode: result.value?.error?.code ?? null,
    identityFailure: message.includes('Selected OpenCode identity is unavailable') || message.includes('not detected on PATH'),
    modelsLoaded: result.code === 0 && result.value?.models?.models?.some((item: Json) => item.providerId === 'opencode') === true,
    error: result.value?.error ?? null,
  }
}

function startContention(): ChildProcess[] {
  return Array.from({ length: os.availableParallelism() * 2 }, () =>
    spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }))
}

const conditions = [
  { name: 'idle', start: async (): Promise<ChildProcess[]> => [] },
  { name: 'contention', start: async () => startContention() },
] as const
const results: Json[] = []
// Keep each baseline outcome: process races are not required to reproduce on
// every runner. Never retry until a desired failure appears.
for (const condition of conditions) {
  const helpers = await condition.start()
  try {
    for (const [runtimeName, runtime] of Object.entries(runtimes)) {
      for (const [selectionName, selection] of Object.entries(selections)) {
        const item = { condition: condition.name, runtime: runtimeName, selection: selectionName,
          ...await models(`${condition.name}-${runtimeName}-${selectionName}`, runtime, selection) }
        results.push(item)
        console.log(JSON.stringify(item))
      }
    }
  } finally { for (const child of helpers) child.kill() }
}
await writeFile(path.join(root, 'identity-e2e-summary.json'), JSON.stringify(results, null, 2))
// Contention starves every step, so the whole catalog can also exceed its own
// 60 s budget there. That budget is separate from selected identity: under
// contention the candidate must never refuse its identity, and idle it must
// load the catalog.
const failedCandidate = results.filter(item => item.runtime === 'candidate' &&
  (item.identityFailure || (item.condition === 'idle' && !item.modelsLoaded)))
console.log(JSON.stringify({ results, limitations: ['CLI boundary only; no inference. CPU contention emulates a busy host; it is not the original user machine.'] }, null, 2))
assert.deepEqual(failedCandidate, [], 'Candidate runtime refused its identity or did not load the idle OpenCode catalog')
