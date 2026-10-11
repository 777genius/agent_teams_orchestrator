import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'

const source = '1e97747ca0581f04c15a4dd5a8365b992bfb295e'
const pattern = 'production relay handshake -> observe -> send: rotated$'
assert.equal(process.platform, 'win32')
assert.equal(process.env.TEST_SOURCE_COMMIT, source)
assert(process.env.TEST_LIVE_PID_TRACE && process.env.TEST_LIVE_PID_RECEIPT)
const started = performance.now(), hash = createHash('sha256')
let parsedBytes = 0, parseOverflow = false
const streams = { stdout: { decoder: new StringDecoder('utf8'), line: '' }, stderr: { decoder: new StringDecoder('utf8'), line: '' } }
let passed = 0, failed = 0, otherResults = 0, ownershipAssertion = false, traceWriteFailed = false
const parseLine = (text: string): void => {
  text = text.replace(/\x1b\[[0-9;]*m/g, '')
  if (text.includes('TEST_LIVE_PID_TRACE_WRITE_FAILED')) traceWriteFailed = true
  if (/\((pass|fail)\)/.test(text)) {
    if (text.includes('pending native OAuth session authority > production relay handshake -> observe -> send: rotated ') ||
        text.endsWith('pending native OAuth session authority > production relay handshake -> observe -> send: rotated')) {
      if (text.includes('(pass)')) passed = 1
      else failed = 1
    } else otherResults += 1
  }
  if (text.includes('Received: "OpenCode cleanup host process ownership is unavailable"')) ownershipAssertion = true
}
const consumeText = (stream: keyof typeof streams, text: string): void => {
  const state = streams[stream]
  for (const character of text) {
    if (character === '\n') { parseLine(state.line); state.line = '' }
    else if (state.line.length < 4096) state.line += character
    else parseOverflow = true
  }
}
const consume = (stream: keyof typeof streams, chunk: Buffer): void => {
  // Hash framed stream labels/byte lengths/chunks in observed callback order.
  hash.update(`${stream}:${chunk.byteLength}:`).update(chunk)
  parsedBytes += chunk.length
  if (parsedBytes > 256 * 1024) { parseOverflow = true; return }
  consumeText(stream, streams[stream].decoder.write(chunk))
}
const child = spawn(process.execPath, ['test', 'src/services/opencode/OpenCodePendingOAuthSession.test.ts',
  '--test-name-pattern', pattern], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
child.stdout.on('data', (chunk: Buffer) => consume('stdout', chunk))
child.stderr.on('data', (chunk: Buffer) => consume('stderr', chunk))
let spawnFailed = false
child.once('error', () => { spawnFailed = true })
const termination = await new Promise<{ code: number | null; signal: string | null }>(resolve =>
  child.once('close', (code, signal) => resolve({ code, signal })))
for (const stream of ['stdout', 'stderr'] as const) {
  consumeText(stream, streams[stream].decoder.end())
  parseLine(streams[stream].line)
}
let traceValid = false, traceSha256: string | null = null, traceEventCount = 0
try {
  const bytes = await readFile(process.env.TEST_LIVE_PID_TRACE)
  traceSha256 = createHash('sha256').update(bytes).digest('hex')
  const events: unknown[] = bytes.toString('utf8').trim().split('\n').map(value => JSON.parse(value))
  traceEventCount = events.length
  traceValid = events.length > 0 && events.length < 200 && events.every(event =>
    event !== null && typeof event === 'object' && 'stage' in event && typeof event.stage === 'string' &&
    event.stage !== 'trace-limit-reached' && 'observerPid' in event && 'targetPid' in event && event.observerPid === event.targetPid)
} catch { /* No trace is diagnostic failure; never substitute an empty census. */ }
const diagnosticValid = !spawnFailed && !parseOverflow && !traceWriteFailed && otherResults === 0 && passed + failed === 1 && traceValid
const receipt = { schema: 1, diagnosticOnly: true, sourceCommit: source, harnessCommit: process.env.TEST_HARNESS_COMMIT,
  runnerOS: process.env.RUNNER_OS, runnerImage: process.env.ImageOS, runnerImageVersion: process.env.ImageVersion,
  bunVersion: Bun.version, pattern, selectedCaseResults: { passed, failed, otherResults },
  elapsedMs: performance.now() - started, ...termination, spawnFailed, parseOverflow, traceWriteFailed, diagnosticValid,
  assertionCategory: ownershipAssertion ? 'cleanup-host-process-ownership-unavailable' : failed ? 'other-test-failure' : 'none',
  capturedOutputSha256: hash.digest('hex'), capturedOutputHashScope: 'stream-name:byte-length: + raw chunk bytes, callback observation order', traceSha256, traceEventCount, noModel: true,
  scope: 'Focused synthetic relay fixture with real live own-PID birth queries; no native/provider qualification' }
await writeFile(process.env.TEST_LIVE_PID_RECEIPT, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(receipt))
process.exitCode = diagnosticValid && termination.code === 0 && termination.signal === null ? 0 : 1
