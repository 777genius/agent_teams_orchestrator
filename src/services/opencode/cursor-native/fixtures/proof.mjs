import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const root = import.meta.dirname, scopes = [], results = {}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const ticks = async name => (await readFile(`${root}/${name}.txt`, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length
async function until(fn) {
  const deadline = Date.now() + 7000
  while (Date.now() < deadline) { if (await fn()) return; await delay(40) }
  throw Error('Fixture deadline')
}
function launch(name, mode, report = `${root}/${name}.json`) {
  const child = spawn(process.execPath, mode === 'launcher'
    ? [`${root}/fake.mjs`, mode, `${root}/${name}.txt`]
    : [`${root}/supervisor.mjs`, process.execPath, `${root}/fake.mjs`, mode, `${root}/${name}.txt`],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CURSOR_SUPERVISOR_REPORT: report } })
  let stderr = ''; child.stderr.on('data', x => { stderr += x })
  child.stderrText = () => stderr
  scopes.push(child); return child
}
const readReport = name => readFile(`${root}/${name}.json`, 'utf8').then(JSON.parse)
async function completed(name) {
  await until(() => readReport(name).then(() => true).catch(() => false))
  const report = await readReport(name)
  assert.equal(report.cleanupCompleted, true, JSON.stringify(report))
  assert.equal(report.remaining.length, 0)
  results[name] = report
  return report
}
try {
  const a = launch('a', 'root'), b = launch('b', 'root')
  await until(async () => await ticks('a') >= 3 && await ticks('b') >= 3)
  a.kill('SIGTERM'); a.kill('SIGTERM')
  const aReport = await completed('a')
  assert.ok(aReport.events.length >= 1)
  const stopped = await ticks('a'), siblingBefore = await ticks('b')
  await delay(350)
  assert.equal(await ticks('a'), stopped)
  assert.ok(await ticks('b') > siblingBefore)
  b.kill('SIGTERM'); await completed('b')
  const orphan = launch('normal-orphan', 'root-orphan')
  const normal = await completed('normal-orphan')
  await until(() => orphan.exitCode !== null)
  assert.equal(orphan.exitCode, 0, orphan.stderrText())
  assert.equal(normal.nativeCode, 0)
  const oldTicks = await ticks('normal-orphan'); await delay(200)
  assert.equal(await ticks('normal-orphan'), oldTicks)
  launch('pending', 'pending'); await completed('pending')
  assert.equal(await ticks('pending'), 0)
  // Negative regression gate: a nested detach leaves every owned group behind.
  const nested = launch('nested', 'root-nested')
  await until(async () => await ticks('nested') >= 4)
  const escaped = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
  nested.kill('SIGTERM')
  const nestedReport = await completed('nested')
  assert.ok(nestedReport.scopeSweep.terminated.length >= 1, JSON.stringify(nestedReport.scopeSweep))
  assert.ok(nestedReport.scopeSweep.escalated, 'a SIGTERM-ignoring escapee must be escalated')
  const nestedStopped = await ticks('nested'); await delay(400)
  assert.equal(await ticks('nested'), nestedStopped)
  const reparented = escaped.trim().split('\n').map(x => x.trim().split(/\s+/))
    .filter(x => nestedReport.scopeSweep.terminated.includes(+x[0]))
  assert.ok(reparented.some(x => +x[2] !== nestedReport.nativePid), 'the escapee must own a separate group')
  const parent = launch('parent-death', 'launcher')
  await until(async () => await ticks('parent-death') >= 3)
  parent.kill('SIGKILL'); await completed('parent-death')
  const echo = launch('streaming', 'root-echo'); let stdout = ''
  echo.stdout.on('data', x => { stdout += x })
  echo.stdin.end('stream-preserved\n'); await completed('streaming')
  assert.equal(stdout, 'stream-preserved\n')
  assert.equal(echo.stderrText(), 'stderr-preserved\n')
  const failedReport = launch('failed-report', 'root', `${root}/missing/report.json`)
  await until(async () => await ticks('failed-report') >= 3)
  failedReport.kill('SIGTERM')
  await until(() => failedReport.exitCode !== null)
  assert.equal(failedReport.exitCode, 70)
  const failedStopped = await ticks('failed-report'); await delay(200)
  assert.equal(await ticks('failed-report'), failedStopped)
  const crash = launch('owner-crash', 'root')
  await until(async () => await ticks('owner-crash') >= 3)
  crash.kill('SIGKILL'); await delay(400)
  const crashStopped = await ticks('owner-crash'); await delay(300)
  assert.equal(await ticks('owner-crash'), crashStopped)
  const live = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' }).trim().split('\n').map(x => x.trim().split(/\s+/))
  const groups = new Set(Object.values(results).flatMap(r => [r.nativePid, ...r.events.map(x => x.pid)]))
  assert.equal(live.filter(x => groups.has(+x[1]) && !x[2].startsWith('Z')).length, 0)
  const swept = new Set(Object.values(results).flatMap(r => r.scopeSweep?.terminated ?? []))
  assert.equal(live.filter(x => swept.has(+x[0]) && !x[2].startsWith('Z')).length, 0)
  await writeFile(`${root}/report.json`, JSON.stringify({ passed: true, scenarios: results, nestedDetachContained: true, ownerCrashNoLateEffects: true, failedReportStillCleans: true }, null, 2))
  console.log(JSON.stringify({ passed: true, scenarios: Object.keys(results), nestedDetachContained: true, ownerCrashNoLateEffects: true }))
} finally {
  for (const child of scopes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
}
