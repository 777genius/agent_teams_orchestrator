// Final check close to the reporting user: published runtime zips in the dev
// runtime-cache layout, global npm OpenCode, the exact failing command.
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
const [shim, ...versions] = process.argv.slice(2)
const binary = version => path.join(os.homedir(), '.agent-teams', 'runtime-cache', version, 'win32-x64', 'payload-v1', 'claude-multimodel.exe')
const run = (command, args, env) => new Promise(resolve => {
  const started = performance.now()
  const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; child.stdout.on('data', c => { out += c })
  const timer = setTimeout(() => child.kill(), 240_000)
  child.once('close', code => { clearTimeout(timer); resolve({ code, ms: Math.round(performance.now() - started), out }) })
})
const results = []
for (const condition of ['idle', 'contention']) {
  const stress = condition === 'idle' ? [] : Array.from({ length: os.availableParallelism() * 2 },
    () => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }))
  try {
    for (const version of versions) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const env = { ...process.env, CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: shim, OPENCODE_BIN_PATH: shim }
        const r = await run(binary(version), ['runtime', 'providers', 'models', '--runtime', 'opencode', '--provider', 'opencode', '--json'], env)
        let value = null; try { value = JSON.parse(r.out) } catch {}
        const message = String(value?.error?.message ?? '')
        const item = { condition, version, attempt, code: r.code, ms: r.ms,
          loaded: r.code === 0 && value?.models?.models?.some(m => m.providerId === 'opencode') === true,
          identityFailure: message.includes('Selected OpenCode identity is unavailable') || message.includes('not detected on PATH'),
          message: message.slice(0, 300) }
        results.push(item); console.log(JSON.stringify(item))
      }
    }
  } finally { for (const child of stress) child.kill() }
}
const fixed = versions.at(-1)
const bad = results.filter(r => r.version === fixed && (r.identityFailure || (r.condition === 'idle' && !r.loaded)))
console.log(JSON.stringify({ fixed, bad: bad.length }))
if (bad.length) process.exit(1)
