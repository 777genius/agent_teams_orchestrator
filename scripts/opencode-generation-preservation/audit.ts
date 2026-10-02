import { readFile, stat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { operations, readers, variants, type Reader, type Variant } from './fixtures'
import { sha256 } from './isolation'
import { assess, decodeObservation } from './evidence'
import { ownerSource, ownerInputPaths, buildWorker } from './baseline'

/** Audits actual byte exports and child receipts, not reader source text. A
 * successful audit proves evidence consistency, never native preservation. */
export async function auditEvidence(dir: string, selectedReaders: Reader[] = [...readers], selectedVariants: Variant[] = [...variants]) {
  const report = JSON.parse(await readFile(path.join(dir, 'store-preservation-baseline.json'), 'utf8'))
  const failures: string[] = []
  const check = (condition: boolean, message: string) => { if (!condition) failures.push(message) }
  const tuples = new Map(selectedReaders.flatMap(reader => selectedVariants.flatMap(variant => operations(reader).map(operation => [`${reader}-${variant}-${operation}`, { reader, variant, operation }] as const))))
  const expected = new Set(tuples.keys())
  const seen = new Set<string>()
  const statuses: Record<string, number> = { OBSERVED: 0, FAIL: 0, MISSING: 0 }
  for (const c of report.cases) {
    if (!expected.has(c.id)) { failures.push('Unexpected case outside the requested matrix'); continue }
    const tuple = tuples.get(c.id)!
    if (!isDeepStrictEqual(tuple, { reader: c.reader, variant: c.variant, operation: c.operation })) { failures.push(`Noncanonical matrix tuple ${c.id}`); continue }
    check(!seen.has(c.id), `Duplicate case ${c.id}`)
    seen.add(c.id)
    const caseDir = path.join(dir, 'cases', c.id)
    const receipt = JSON.parse(await readFile(path.join(caseDir, 'process.json'), 'utf8'))
    const observation = JSON.parse(await readFile(path.join(caseDir, 'observation.json'), 'utf8'))
    check(isDeepStrictEqual(observation, c), `Report/observation mismatch ${c.id}`)
    check(['NOT_REQUESTED', 'CAPTURED', 'MISSING_PTRACE'].includes(receipt.traceStatus) && receipt.traceStatus === c.traceStatus, `Trace status mismatch ${c.id}`)
    const exists = (file: string) => stat(path.join(caseDir, file)).then(() => true, () => false)
    check(await exists('trace-unavailable.json') === (receipt.traceStatus === 'MISSING_PTRACE'), `Trace denial receipt mismatch ${c.id}`)
    if (receipt.traceStatus === 'CAPTURED') check(await exists('syscalls.log'), `Captured trace missing ${c.id}`)
    check(receipt.childTerminal === true && c.processes.terminal === true, `Child not terminal ${c.id}`)
    const raw = decodeObservation({ code: receipt.code, stdout: receipt.stdout, stderr: receipt.stderr, pid: receipt.pid } as any)
    check(isDeepStrictEqual(raw, c.observation), `Raw child/result mismatch ${c.id}`)
    check(c.qualification === raw.qualification, `Qualification mismatch ${c.id}`)
    const effects = {
      added: Object.keys(c.afterFiles).filter(file => !c.beforeFiles[file]),
      removed: Object.keys(c.beforeFiles).filter(file => !c.afterFiles[file]),
      modified: Object.keys(c.beforeFiles).filter(file => c.afterFiles[file] && c.afterFiles[file].sha256 !== c.beforeFiles[file].sha256),
    }
    check(isDeepStrictEqual(effects, c.fileEffects), `File effect mismatch ${c.id}`)
    check(isDeepStrictEqual(c.before, c.beforeFiles['store.json'] ?? null) && isDeepStrictEqual(c.after, c.afterFiles['store.json'] ?? null), `Store snapshot mismatch ${c.id}`)
    for (const [field, file] of [['before', 'original.bin'], ['after', 'after.bin']]) {
      if (c[field]) {
        const data = await readFile(path.join(caseDir, file!))
        check(sha256(data) === c[field].sha256 && data.length === c[field].bytes, `Byte export mismatch ${c.id}/${file}`)
      } else check(!(await stat(path.join(caseDir, file!)).then(() => true, () => false)), `Unexpected byte export ${c.id}/${file}`)
    }
    const changed = (c.before?.sha256 ?? null) !== (c.after?.sha256 ?? null)
    check(isDeepStrictEqual(c.preservation, assess(c.reader, c.variant, c.operation, raw, changed, effects.added)), `Derived preservation mismatch ${c.id}`)
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
  // Derive the required set from our trusted bundler and fixed owner list.
  // Report paths are compared to that set before any source read, never followed.
  const bundled = await buildWorker()
  const required = new Map(bundled.inputFiles.map(input => [input.path, input.sha256]))
  for (const relative of ownerInputPaths) {
    const absolute = path.join(ownerSource, relative)
    required.set(absolute, sha256(await readFile(absolute)))
  }
  for (const [name, list] of [['inputFiles', report.inputFiles], ['inputPreservation', report.inputPreservation]] as const) {
    check(Array.isArray(list) && list.length === required.size, `Incomplete canonical source set ${name}`)
    const paths = new Set<string>()
    for (const input of Array.isArray(list) ? list : []) {
      if (!required.has(input.path)) { failures.push('Source input outside allowed immutable inputs'); continue }
      check(!paths.has(input.path), `Duplicate source input ${name}`)
      paths.add(input.path)
      check(await realpath(input.path).catch(() => null) === input.path, 'Source input alias')
      check(input.sha256 === required.get(input.path), `Source input changed ${input.path}`)
      if (name === 'inputPreservation') check(input.unchanged === true && input.sha256 === input.afterSha256, `Source input changed ${input.path}`)
    }
    check(paths.size === required.size, `Missing required source inputs ${name}`)
  }
  return { ok: failures.length === 0, failures, casesChecked: seen.size, counts: statuses,
    scope: 'Actual byte exports, child receipts, matrix completeness and canonical source inputs and derived classifications; not native effects or Git metadata qualification' }
}
