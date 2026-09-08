#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

if (process.argv.includes('--version')) {
  console.log('transport-fake-cursor 0.0.0')
  process.exit(0)
}
const role = process.argv[2]
if (role === 'child' || role === 'grandchild') {
  const [caseId, logRoot] = process.argv.slice(3)
  const logPath = path.join(logRoot!, `${caseId}.jsonl`)
  process.on('SIGTERM', () => {})
  if (role === 'child') spawn(process.execPath, [process.argv[1]!, 'grandchild', caseId!, logRoot!], { stdio: 'ignore' })
  appendFileSync(logPath, JSON.stringify({ descendantPid: process.pid, role }) + '\n')
  setTimeout(async () => {
    writeFileSync(path.join(logRoot!, `${caseId}-${role}.effect`), 'late effect')
    if (process.env.CURSOR_TRANSPORT_TEST_MCP_CLI) {
      const effect = Bun.spawn([process.execPath, process.env.CURSOR_TRANSPORT_TEST_MCP_CLI,
        'call', 'fixture', 'receipt', JSON.stringify({ id: `${caseId}-${role}` })], { stdout: 'ignore', stderr: 'ignore' })
      await effect.exited
    }
    process.exit(0)
  }, 2000)
  await new Promise(() => {})
}
const prompt = await Bun.stdin.text()
const id = /CASE:([a-z]+)/.exec(prompt)?.[1]
const logRoot = process.env.CURSOR_TRANSPORT_TEST_LOG_ROOT
if (!id || !logRoot) throw new Error('Missing fake transport case')
const log = (value: unknown) => appendFileSync(
  path.join(logRoot, `${id}.jsonl`), JSON.stringify(value) + '\n',
)
const finish = (code: number) => process.exit(code)
process.on('SIGTERM', () => {
  if (id !== 'resistant') finish(143)
})
log({ pid: process.pid, startedAt: Date.now(), requestId: process.env.CURSOR_OWNER_REQUEST_ID })
// Even a broken cancellation implementation cannot leave this fixture forever.
setTimeout(() => process.exit(2), 30_000)
if (['tree', 'resistant', 'silent', 'buffered'].includes(id)) {
  spawn(process.execPath, [process.argv[1]!, 'child', id, logRoot], { stdio: 'ignore' })
}
if (id === 'silent') await Bun.sleep(12_000)
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
