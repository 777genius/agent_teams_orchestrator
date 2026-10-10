import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { readProcessStartTimeMs } from '../../../utils/processKill.js'
import { inspectOpenCodeReadSelection } from './OpenCodeNativeIdentity.js'

const [mode, marker, executable] = process.argv.slice(2)
if (!mode || !marker) throw new Error('Missing TEST fixture arguments')

if (mode === 'holder' || mode === 'foreign') {
  const birth = await readProcessStartTimeMs(process.pid)
  if (birth === null) throw new Error('Unreadable TEST process birth')
  writeFileSync(marker, JSON.stringify({ pid: process.pid, birth, root: process.cwd() }))
  const heartbeat = setInterval(() => appendFileSync(marker + '.heartbeat', '.'), 20)
  process.send?.({ type: 'holding' })
  process.on('disconnect', () => { /* Hold inherited stdout after the leader exits. */ })
  process.on('SIGTERM', () => { clearInterval(heartbeat); process.exit(0) })
} else if (mode === 'leader') {
  const birth = await readProcessStartTimeMs(process.pid)
  writeFileSync(marker + '.leader', JSON.stringify({ pid: process.pid, birth, root: process.cwd() }))
  const holder = spawn(process.execPath, [import.meta.path, 'holder', marker], {
    stdio: ['ignore', 'inherit', 'ignore', 'ipc'], env: process.env,
  })
  holder.once('message', () => {
    process.stdout.write('1.18.34\n')
    // Permit an independent ownership snapshot, then exercise leader exit
    // while the child remains alive with inherited stdout and heartbeats.
    setTimeout(() => process.exit(0), 500)
  })
} else if (mode === 'inspect' || mode === 'abort') {
  if (!executable) throw new Error('Missing selected TEST executable')
  process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = executable
  const controller = new AbortController()
  let acquiring = false
  try {
    const result = await inspectOpenCodeReadSelection(controller.signal, () => {
      acquiring = true
      if (mode === 'abort') queueMicrotask(() => controller.abort())
    })
    process.stdout.write(JSON.stringify({ result, acquiring, markerExists: existsSync(marker) }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown', acquiring,
      markerExists: existsSync(marker) }) + '\n')
  }
} else throw new Error('Unknown TEST fixture mode')
