#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

if (process.argv.includes('--version')) {
  console.log('transport-fake-cursor 0.0.0')
  process.exit(0)
}
const prompt = await Bun.stdin.text()
const id = /CASE:([a-z]+)/.exec(prompt)?.[1]
const logRoot = process.env.CURSOR_TRANSPORT_TEST_LOG_ROOT
if (!id || !logRoot) throw new Error('Missing fake transport case')
const log = (value: unknown) => appendFileSync(
  path.join(logRoot, `${id}.jsonl`), JSON.stringify(value) + '\n',
)
const finish = (code: number) => {
  if (process.env.CURSOR_SUPERVISOR_REPORT) {
    writeFileSync(process.env.CURSOR_SUPERVISOR_REPORT, JSON.stringify({
      version: 1, requestId: process.env.CURSOR_OWNER_REQUEST_ID, supervisorPid: process.pid,
      cleanupCompleted: true, failures: [], remaining: [],
    }), { mode: 0o600 })
  }
  process.exit(code)
}
process.once('SIGTERM', () => finish(143))
log({ pid: process.pid, startedAt: Date.now(), requestId: process.env.CURSOR_OWNER_REQUEST_ID })
// Even a broken cancellation implementation cannot leave this fixture forever.
setTimeout(() => process.exit(2), 30_000)
if (id === 'slow') await Bun.sleep(12_000)
let count = 0
setInterval(() => {
  log({ count: ++count })
  console.log(JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${id}:${count}` }] },
  }))
  if ((id === 'normal' || id === 'followup') && count === 8) {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }))
    finish(0)
  }
}, 100)
