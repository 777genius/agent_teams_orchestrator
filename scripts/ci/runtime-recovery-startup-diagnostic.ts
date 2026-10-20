// Isolated diagnostic branch only; never a replacement for unmodified main CI.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const source = 'e1892ddd32230736c29469d5347a1b659cd49945'
const testPath = 'src/services/opencode/OpenCodeOAuthRestartRecovery.test.ts'
const controllerPath = 'scripts/ci/runtime-recovery-startup-diagnostic.ts'
const evidenceRoot = path.resolve('runtime-recovery-diagnostic-evidence')
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
mkdirSync(evidenceRoot, { recursive: true })
assert.equal(process.platform, 'win32')
assert.equal(Bun.version, '1.4.3')
assert.equal(git('rev-parse', 'HEAD^'), '52f754060a4dc2aea59c98f449f8192db49d8e68')
assert.equal(git('rev-parse', 'HEAD^^'), source)
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '')
assert.deepEqual(git('diff', '--name-only', source, 'HEAD').split('\n').sort(),
  ['.github/workflows/ci.yml', controllerPath, testPath].sort())
const metadata = JSON.parse(readFileSync('package.json', 'utf8'))
const authorityCommand = metadata.scripts['test:opencode-authority']
assert.equal(authorityCommand, JSON.parse(git('show', `${source}:package.json`)).scripts['test:opencode-authority'])
// Windows checkout can materialize CRLF; require the unchanged canonical Git
// content while retaining the actual checked-out bytes in the provenance.
const lockGitBlob = git('hash-object', '--path=bun.lock', 'bun.lock')
assert.equal(lockGitBlob, git('rev-parse', `${source}:bun.lock`))
const provenance = {
  source, diagnosticCommit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
  runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  bunVersion: Bun.version, nodeVersion: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(),
  platform: process.platform, arch: process.arch, authorityCommand,
  args: ['run', 'test:opencode-authority', '--timeout', '30000'],
  untouchedTimeoutMs: 30000, productionSourcesUnchanged: true,
  fullPrecedingAuthorityContext: true, repetitions: 1, qualification: false,
  lockGitBlob, lockCheckoutSha256: hash(readFileSync('bun.lock')),
  sourceTestSha256: hash(execFileSync('git', ['show', `${source}:${testPath}`])),
  tracedTestSha256: hash(readFileSync(testPath)), startedAt: new Date().toISOString(),
}
writeFileSync(path.join(evidenceRoot, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n')
writeFileSync(path.join(evidenceRoot, 'instrumentation.diff'), git('diff', source, 'HEAD', '--', testPath) + '\n')
writeFileSync(path.join(evidenceRoot, 'source-test.ts.txt'), execFileSync('git', ['show', `${source}:${testPath}`]))
writeFileSync(path.join(evidenceRoot, 'traced-test.ts.txt'), readFileSync(testPath))
writeFileSync(path.join(evidenceRoot, 'controller.ts.txt'), readFileSync(controllerPath))
writeFileSync(path.join(evidenceRoot, 'workflow.yml'), readFileSync('.github/workflows/ci.yml'))
const stdoutPath = path.join(evidenceRoot, 'authority.stdout.log')
const stderrPath = path.join(evidenceRoot, 'authority.stderr.log')
writeFileSync(stdoutPath, ''); writeFileSync(stderrPath, '')
const start = performance.now()
const child = spawn(process.execPath, provenance.args, {
  cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
child.stdout.on('data', data => { appendFileSync(stdoutPath, data); process.stdout.write(data) })
child.stderr.on('data', data => { appendFileSync(stderrPath, data); process.stderr.write(data) })
let spawnError: string | null = null
child.once('error', error => { spawnError = error.message })
const closed = await new Promise<{ code: number | null, signal: string | null }>(resolve => {
  child.once('close', (code, signal) => resolve({ code, signal }))
})
const stdout = readFileSync(stdoutPath, 'utf8'), stderr = readFileSync(stderrPath, 'utf8')
const summary = {
  ...provenance, completedAt: new Date().toISOString(), elapsedMs: performance.now() - start,
  ...closed, spawnError, stdoutSha256: hash(stdout), stderrSha256: hash(stderr),
  expectedTests: 1585, expectedFiles: 47, expectedPass: 1577, expectedSkip: 8,
  exactCountObserved: /Ran 1585 tests across 47 files/.test(stderr),
  exactPassObserved: /(?:^|\n)\s*1577 pass(?:\r?\n|$)/.test(stderr),
  exactSkipObserved: /(?:^|\n)\s*8 skip(?:\r?\n|$)/.test(stderr),
  zeroFailuresObserved: /(?:^|\n)\s*0 fail(?:\r?\n|$)/.test(stderr),
}
writeFileSync(path.join(evidenceRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
assert.equal(spawnError, null)
assert.equal(closed.signal, null)
assert.equal(closed.code, 0)
assert(summary.exactCountObserved && summary.exactPassObserved && summary.exactSkipObserved && summary.zeroFailuresObserved,
  'Full unchanged authority test discovery/result count required; inspect saved raw evidence')
console.log('Diagnostic full authority completed once; actual main CI qualification remains required.')
