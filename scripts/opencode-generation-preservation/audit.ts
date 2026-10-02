import { readFile, stat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { operations, readers, variants, type Reader, type Variant } from './fixtures'
import { sha256 } from './isolation'
import { ownerSource } from './baseline'

/** Audits actual byte exports and child receipts, not reader source text. A
 * successful audit proves evidence consistency, never native preservation. */
export async function auditEvidence(dir: string, selectedReaders: Reader[] = [...readers], selectedVariants: Variant[] = [...variants]) {
  const report = JSON.parse(await readFile(path.join(dir, 'store-preservation-baseline.json'), 'utf8'))
  const failures: string[] = []
  const check = (condition: boolean, message: string) => { if (!condition) failures.push(message) }
  const expected = new Set(selectedReaders.flatMap(reader => selectedVariants.flatMap(variant => operations(reader).map(operation => `${reader}-${variant}-${operation}`))))
  const seen = new Set<string>()
  const statuses: Record<string, number> = { OBSERVED: 0, FAIL: 0, MISSING: 0 }
  for (const c of report.cases) {
    if (!expected.has(c.id)) { failures.push('Unexpected case outside the requested matrix'); continue }
    check(!seen.has(c.id), `Duplicate case ${c.id}`)
    seen.add(c.id)
    const caseDir = path.join(dir, 'cases', c.id)
    const receipt = JSON.parse(await readFile(path.join(caseDir, 'process.json'), 'utf8'))
    const observation = JSON.parse(await readFile(path.join(caseDir, 'observation.json'), 'utf8'))
    check(isDeepStrictEqual(observation, c), `Report/observation mismatch ${c.id}`)
    check(receipt.childTerminal === true && c.processes.terminal === true, `Child not terminal ${c.id}`)
    if (receipt.code === 0) {
      const raw = JSON.parse(receipt.stdout.trim().split('\n').at(-1))
      check(isDeepStrictEqual(raw, c.observation), `Raw child/result mismatch ${c.id}`)
    }
    for (const [field, file] of [['before', 'original.bin'], ['after', 'after.bin']]) {
      if (c[field]) {
        const data = await readFile(path.join(caseDir, file!))
        check(sha256(data) === c[field].sha256 && data.length === c[field].bytes, `Byte export mismatch ${c.id}/${file}`)
      } else check(!(await stat(path.join(caseDir, file!)).then(() => true, () => false)), `Unexpected byte export ${c.id}/${file}`)
    }
    const changed = (c.before?.sha256 ?? null) !== (c.after?.sha256 ?? null)
    check(c.originalChanged === changed, `Incorrect byte-change status ${c.id}`)
    check(c.preservation.status in statuses, `Invalid preservation status ${c.id}`)
    if (c.preservation.status in statuses) statuses[c.preservation.status]++
    if (c.qualification === 'MISSING') check(c.preservation.status === 'MISSING', `Unavailable reader promoted ${c.id}`)
    if (c.variant === 'unreadable' && c.qualification === 'OBSERVED') {
      check(c.observation.privilege.uidAfter !== 0 && c.observation.privilege.probe?.code === 'EACCES', `Root chmod promoted to unprivileged EACCES ${c.id}`)
    }
    for (const file of c.fileEffects.added.filter((f: string) => f.endsWith('.quarantine'))) {
      const data = await readFile(path.join(caseDir, path.basename(file)))
      check(sha256(data) === c.afterFiles[file].sha256, `Quarantine byte export mismatch ${c.id}/${file}`)
    }
  }
  for (const id of expected) check(seen.has(id), `Missing case ${id}`)
  check(isDeepStrictEqual(statuses, report.counts), 'Summary counts differ from case statuses')
  check(report.fullDualSupportQualified === false && report.finalPreservationQualified === false, 'Baseline promoted to final support/preservation')
  for (const input of report.inputPreservation) {
    if (typeof input.path !== 'string') { failures.push('Invalid source input path'); continue }
    const absolute = path.resolve(input.path)
    const relative = path.relative(ownerSource, absolute).split(path.sep).join('/')
    const known = ['package.json', 'bun.lock', '.task-inputs/inputs.json', '.task-inputs/plan.md'].includes(relative)
    const source = /^(?:src\/|scripts\/opencode-generation-preservation\/|\.task-inputs\/product\/src\/).*\.ts$/.test(relative)
    if ((!known && !source) || await realpath(absolute).catch(() => null) !== absolute) {
      failures.push('Source input outside allowed immutable inputs'); continue
    }
    const current = sha256(await readFile(absolute))
    check(input.unchanged === true && input.sha256 === input.afterSha256 && current === input.sha256, `Source input changed ${input.path}`)
  }
  return { ok: failures.length === 0, failures, casesChecked: seen.size, counts: statuses,
    scope: 'Actual byte exports, child receipts, matrix completeness and selected source inputs; not native effects or Git metadata qualification' }
}
