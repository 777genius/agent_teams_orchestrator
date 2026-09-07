import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const [mode, file] = process.argv.slice(2)
if (mode === 'writer') {
  process.on('SIGTERM', () => {})
  setInterval(() => appendFileSync(file, `${process.pid}\n`), 40)
} else if (mode === 'orphan') {
  spawn(process.execPath, [import.meta.filename, 'writer', file], { stdio: 'inherit' })
  setTimeout(() => process.exit(0), 150)
} else if (mode === 'nested') {
  // No preload reaches here, so this detach escapes group ownership entirely.
  spawn(process.execPath, [import.meta.filename, 'writer', file], { detached: true, stdio: 'ignore' }).unref()
  setTimeout(() => process.exit(0), 200)
} else if (mode === 'root-nested') {
  spawn(process.execPath, [import.meta.filename, 'nested', file], { detached: true, stdio: 'inherit' })
  setInterval(() => {}, 100)
} else if (mode === 'echo') {
  process.stdin.pipe(process.stdout)
  process.stderr.write('stderr-preserved\n')
} else if (mode === 'launcher') {
  spawn(process.execPath, [import.meta.dirname + '/supervisor.mjs',
    process.execPath, import.meta.filename, 'root', file], { stdio: 'inherit' })
  setInterval(() => {}, 100)
} else {
  const child = spawn(process.execPath, [import.meta.filename,
    mode === 'root-orphan' ? 'orphan' : mode === 'root-echo' ? 'echo' : 'writer', file],
  { detached: true, stdio: 'inherit' })
  if (mode === 'pending') process.exit(0)
  child.on('exit', code => process.exit(code ?? 1))
}
