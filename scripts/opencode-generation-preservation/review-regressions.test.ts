import { beforeAll, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat, cp } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { runBaseline, ownerSource } from './baseline'
import { auditEvidence } from './audit'
import { renderReport } from './report'
import { command, childEnvironment, safeWrite } from './isolation'
const bun = path.join(ownerSource, '.task-inputs/toolchain/bun')
let root: string, evidence: string, report: any, markdown: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'TEST-review-regressions-'))
  evidence = path.join(root, 'evidence')
  const env = childEnvironment(root, bun)
  for (const value of Object.values(env).filter(value => value.startsWith(root))) await mkdir(value, { recursive: true })
  const child = await command(bun, [path.join(ownerSource, 'scripts/opencode-generation-preservation-baseline.ts'), '--evidence-dir', evidence, '--test-parent', path.join(root, 'projects'), '--no-export'], ownerSource, env)
  if (child.code !== 0) throw new Error(child.stderr + child.stdout)
  expect(child.code).toBe(0)
  report = JSON.parse(await readFile(path.join(evidence, 'store-preservation-baseline.json'), 'utf8'))
  markdown = await readFile(path.join(evidence, 'report.md'), 'utf8')
  console.log(JSON.stringify({ evidence, counts: report.counts, cases: report.cases.length, native: false }))
}, 120000)
// Breaks if either output can reach source, or evidence aliases overwrite foreign bytes.
test('F01 rejects source, aliases, and overlapping roots before any output', async () => {
  const source = path.join(ownerSource, 'TEST-forbidden-evidence')
  await expect(runBaseline({ evidenceDir: source, testParent: path.join(root, 'unused'), selectedReaders: [] })).rejects.toThrow()
  expect(await stat(source).then(() => true, () => false)).toBe(false)
  const guardedEvidence = path.join(root, 'test-root-rejection-evidence')
  await expect(runBaseline({ evidenceDir: guardedEvidence, testParent: source, selectedReaders: [] })).rejects.toThrow()
  expect(await stat(guardedEvidence).then(() => true, () => false)).toBe(false)
  const sourceAlias = path.join(root, 'source-alias')
  await symlink(ownerSource, sourceAlias)
  await expect(runBaseline({ evidenceDir: path.join(sourceAlias, 'TEST-forbidden-evidence'), testParent: path.join(root, 'unused'), selectedReaders: [] })).rejects.toThrow()
  expect(await stat(source).then(() => true, () => false)).toBe(false)
  const target = path.join(root, 'TEST-unrelated')
  await mkdir(path.join(target, 'INPUT'), { recursive: true })
  const sentinel = path.join(target, 'INPUT/reader-worker.js')
  await writeFile(sentinel, 'TEST-preserve-me')
  const alias = path.join(root, 'alias')
  await symlink(target, alias)
  await expect(runBaseline({ evidenceDir: alias, testParent: path.join(root, 'unused'), selectedReaders: [] })).rejects.toThrow()
  expect(await readFile(sentinel, 'utf8')).toBe('TEST-preserve-me')
  await expect(runBaseline({ evidenceDir: path.join(target, 'fresh-evidence'), testParent: alias, selectedReaders: [] })).rejects.toThrow()
  expect(await stat(path.join(target, 'fresh-evidence')).then(() => true, () => false)).toBe(false)
  await expect(runBaseline({ evidenceDir: target, testParent: path.join(root, 'unused'), selectedReaders: [] })).rejects.toThrow()
  expect(await readFile(sentinel, 'utf8')).toBe('TEST-preserve-me')
  const fileAlias = path.join(root, 'file-alias')
  await symlink(sentinel, fileAlias)
  await expect(safeWrite(fileAlias, 'TEST-overwrite')).rejects.toThrow()
  await expect(safeWrite(path.join(alias, 'INPUT/reader-worker.js'), 'TEST-overwrite')).rejects.toThrow()
  expect(await readFile(sentinel, 'utf8')).toBe('TEST-preserve-me')
  expect(await stat(path.join(root, 'unused')).then(() => true, () => false)).toBe(false)
  await expect(runBaseline({ evidenceDir: path.join(root, 'overlap'), testParent: path.join(root, 'overlap/projects'), selectedReaders: [] })).rejects.toThrow()
  expect(await stat(path.join(root, 'overlap')).then(() => true, () => false)).toBe(false)
})
// Breaks if accepted partial authority is mislabeled rejection; real reader, fake transport.
test('F02 partial host acceptance is a retained-byte hazard', async () => {
  const c = report.cases.find((c: any) => c.id === 'host-partial-resolveOwnedSessionEndpoint')
  expect(c.observation.returned).toBe(true)
  expect(c.observation.result).toEqual({ baseUrl: 'http://127.0.0.1:49123', pid: 99001 })
  expect(c.observation.effects).toEqual([])
  expect(c.before).toEqual(c.after)
  expect(c.preservation.status).toBe('FAIL')
  expect(c.preservation.reason).toContain('without uncertainty veto')
  expect(await readFile(path.join(evidence, 'cases', c.id, 'original.bin'))).toEqual(await readFile(path.join(evidence, 'cases', c.id, 'after.bin')))
})
async function copyReport(name: string) {
  const dir = path.join(root, name)
  await cp(evidence, dir, { recursive: true })
  return { dir, changed: JSON.parse(JSON.stringify(report)), file: path.join(dir, 'store-preservation-baseline.json') }
}
// Breaks if counts and edited summaries can override raw child evidence.
test('F03 audit rejects false classification and canonical tuple changes', async () => {
  const { dir, changed, file } = await copyReport('false-classification')
  const c = changed.cases.find((c: any) => c.id === 'outcome-future-query')
  c.preservation = { status: 'OBSERVED', reason: 'Public reader rejected; original retained' }
  changed.counts.FAIL--; changed.counts.OBSERVED++
  await writeFile(file, JSON.stringify(changed))
  await writeFile(path.join(dir, 'cases', c.id, 'observation.json'), JSON.stringify(c))
  expect((await auditEvidence(dir)).ok).toBe(false)
  const tuple = await copyReport('false-tuple')
  tuple.changed.cases[0].variant = 'missing'
  await writeFile(tuple.file, JSON.stringify(tuple.changed))
  await writeFile(path.join(tuple.dir, 'cases', tuple.changed.cases[0].id, 'observation.json'), JSON.stringify(tuple.changed.cases[0]))
  expect((await auditEvidence(tuple.dir)).ok).toBe(false)
})
// Breaks if either source list can omit mandatory inputs, even when both agree.
test('F03 audit requires complete consistent canonical source sets', async () => {
  for (const mode of ['empty', 'both-omit', 'inputFiles-omit', 'product-omit', 'plan-omit', 'lock-omit']) {
    const { dir, changed, file } = await copyReport(mode)
    if (mode === 'empty') changed.inputPreservation = []
    else if (mode === 'both-omit') {
      changed.inputFiles.pop(); changed.inputPreservation.pop()
    } else if (mode === 'inputFiles-omit') changed.inputFiles.pop()
    else {
      const match = (input: any) => mode === 'product-omit' ? input.path.includes('/product/') : input.path.endsWith(mode === 'plan-omit' ? '/plan.md' : '/bun.lock')
      changed.inputFiles = changed.inputFiles.filter((input: any) => !match(input))
      changed.inputPreservation = changed.inputPreservation.filter((input: any) => !match(input))
    }
    await writeFile(file, JSON.stringify(changed))
    expect((await auditEvidence(dir)).ok).toBe(false)
  }
  expect((await auditEvidence(evidence)).ok).toBe(true)
})
// Public CLI output must describe actual receipts, not invented load/trace failures.
test('F04 Markdown agrees with recorded qualifications and trace receipts', async () => {
  expect(markdown).toContain(`Counts: ${JSON.stringify(report.counts)}`)
  expect(markdown).not.toContain('their real public readers could not load here')
  expect(markdown).not.toContain('Syscall tracing was attempted and ptrace was denied')
  expect(markdown).toContain(`NOT_REQUESTED=${report.cases.length}`)
  expect(markdown).toContain('CAPTURED=0')
  expect(markdown).toContain('MISSING_PTRACE=0')
  const gaps = report.cases.filter((c: any) => c.observation.reason === 'Actual unprivileged EACCES unavailable').length
  expect(markdown).toContain(`EACCES privilege gaps=${gaps}`)
  for (const c of report.cases) expect(await stat(path.join(evidence, 'cases', c.id, 'trace-unavailable.json')).then(() => true, () => false)).toBe(false)
})

// Formatting contract for recorded trace modes and reader-load gaps; these
// synthetic receipts assert rendering only, never native/tracing execution.
test('F04 rendering distinguishes captured, denied and reader-load records', () => {
  const recorded = { ...report, cases: [
    { ...report.cases[0], traceStatus: 'CAPTURED' },
    { ...report.cases[1], traceStatus: 'MISSING_PTRACE' },
    { ...report.cases[2], traceStatus: 'NOT_REQUESTED', qualification: 'MISSING', observation: { stage: 'reader-load' } },
  ] }
  const output = renderReport(recorded)
  expect(output).toContain('NOT_REQUESTED=1, CAPTURED=1, MISSING_PTRACE=1')
  expect(output).toContain('Reader-load gaps=1. EACCES privilege gaps=0')
})
