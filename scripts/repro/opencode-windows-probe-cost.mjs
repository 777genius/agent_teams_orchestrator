// Exploratory Windows reproduction: measure the cost of the native identity
// helpers used by the OpenCode version probe and run the real runtime command
// with and without CPU contention. No inference; disposable runner only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const [rootArg, runtimeArg, ...selectionArgs] = process.argv.slice(2)
assert(process.platform === 'win32', 'Windows only')
assert(rootArg && runtimeArg && selectionArgs.length, 'Expected TEST root, runtime and name=path selections')
const root = path.resolve(rootArg)
const selections = selectionArgs.map(value => {
  const index = value.indexOf('=')
  return { name: value.slice(0, index), path: value.slice(index + 1) }
})
const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const birthScript = pid => `$ErrorActionPreference = "Stop"; $p = $null; $stage = 'process_lookup';
try {
  $p = [System.Diagnostics.Process]::GetProcessById(${pid});
  $stage = 'start_time'; $p.StartTime.ToUniversalTime().ToString("o")
} catch { exit 1 } finally { if ($null -ne $p) { $p.Dispose() } }`
const treeScript = `$ErrorActionPreference = 'Stop';
[void][System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');
$searcher = [System.Management.ManagementObjectSearcher]::new('SELECT ProcessId, ParentProcessId FROM Win32_Process');
$results = $null;
try {
  $results = $searcher.Get();
  foreach ($row in $results) {
    try { [Console]::Out.WriteLine('{0} {1}', $row.GetPropertyValue('ProcessId'), $row.GetPropertyValue('ParentProcessId')) }
    finally { $row.Dispose() }
  }
} finally { if ($null -ne $results) { $results.Dispose() }; $searcher.Dispose() }`

function run(command, args, options = {}) {
  const started = performance.now()
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 150_000)
    child.once('error', error => { stderr += String(error) })
    child.once('close', code => {
      clearTimeout(timer)
      resolve({ code, ms: Math.round(performance.now() - started), stdout, stderr })
    })
  })
}

async function microbench(label) {
  const births = [], trees = []
  for (let index = 0; index < 4; index++) {
    births.push((await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', birthScript(process.pid)])).ms)
    const tree = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', treeScript])
    trees.push(tree.ms)
  }
  return { label, birthMs: births, treeMs: trees }
}

function isolatedEnv(own, selection) {
  const dirs = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata',
    'runtime-data', 'runtime-cache', 'project'].map(name => [name, path.join(own, name)]))
  const env = {}
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  Object.assign(env, {
    HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata,
    XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
    TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp, CI: '1', NO_COLOR: '1',
    CLAUDE_MULTIMODEL_DATA_HOME: dirs['runtime-data'], CLAUDE_MULTIMODEL_CACHE_HOME: dirs['runtime-cache'],
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: selection.path,
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  })
  return { env, dirs }
}

async function runtimeCases(label) {
  const results = []
  for (const selection of selections) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const own = path.join(root, `${label}-${selection.name}-${attempt}`)
      const { env, dirs } = isolatedEnv(own, selection)
      await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true })))
      const result = await run(runtimeArg, ['runtime', 'providers', 'models', '--runtime', 'opencode', '--provider', 'opencode', '--json'],
        { cwd: dirs.project, env })
      const identity = /Selected OpenCode identity is unavailable[^"]*(?:\[identityDiagnostic=.*?\]\])?/.exec(result.stdout + result.stderr)?.[0] ?? null
      results.push({ selection: selection.name, attempt, code: result.code, ms: result.ms, identityFailure: identity,
        stdoutHead: result.stdout.slice(0, 1500), stderrHead: result.stderr.slice(0, 1500) })
      console.log(JSON.stringify(results.at(-1)))
    }
  }
  return results
}

function startStress() {
  const count = Math.max(2, os.availableParallelism() * 2)
  return Array.from({ length: count }, () => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }))
}

const report = { cpus: os.availableParallelism(), runtime: runtimeArg, selections, phases: [] }
for (const stressed of [false, true]) {
  const label = stressed ? 'stressed' : 'idle'
  const stress = stressed ? startStress() : []
  try {
    await new Promise(resolve => setTimeout(resolve, stressed ? 2000 : 0))
    const bench = await microbench(label)
    console.log(JSON.stringify(bench))
    const cases = await runtimeCases(label)
    report.phases.push({ label, bench, cases })
  } finally {
    for (const child of stress) child.kill()
  }
}
await writeFile(path.join(root, 'probe-cost-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report.phases.map(phase => ({ label: phase.label, bench: phase.bench,
  cases: phase.cases.map(item => ({ selection: item.selection, code: item.code, ms: item.ms, failed: Boolean(item.identityFailure) })) })), null, 2))
