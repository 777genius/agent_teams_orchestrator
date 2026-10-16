// Calibrate contention: opencode --version vs PowerShell helper cost per stress level.
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
const [shim, native] = process.argv.slice(2)
const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const run = (command, args) => new Promise(resolve => {
  const started = performance.now()
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: command.endsWith('.cmd') })
  let out = ''; child.stdout.on('data', c => { out += c })
  child.once('close', code => resolve({ code, ms: Math.round(performance.now() - started), out: out.trim().slice(0, 40) }))
})
for (const factor of [0, 0.5, 1, 2]) {
  const count = Math.round(os.availableParallelism() * factor)
  const stress = Array.from({ length: count }, () => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }))
  await new Promise(resolve => setTimeout(resolve, 1500))
  const sample = { factor, count, native: [], shim: [], birth: [] }
  for (let i = 0; i < 3; i++) {
    sample.native.push((await run(native, ['--version'])).ms)
    sample.shim.push((await run(shim, ['--version'])).ms)
    sample.birth.push((await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', `[System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().ToString("o")`])).ms)
  }
  for (const child of stress) child.kill()
  console.log(JSON.stringify(sample))
}
