import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile, cp } from 'node:fs/promises'
import path from 'node:path'
import { persistentRoot, runBaseline, sealArtifacts } from './baseline'
import { auditEvidence } from './audit'

// Regression: the report could call future-schema/null or quarantine a PASS,
// hiding the prerequisite failure. Existing store suites test happy-path data;
// this suite qualifies the real public readers and records the preservation hazard.
let report: any
let evidence: string
beforeAll(async () => {
  evidence = await mkdtemp(path.join(persistentRoot, 'S5a-focused-evidence-'))
  const projects = await mkdtemp(path.join(persistentRoot, 'S5a-focused-TEST-parent-'))
  report = await runBaseline({ evidenceDir: evidence, testParent: projects,
    selectedReaders: ['outcome', 'manifest-evidence', 'manifest-store', 'versioned'],
    selectedVariants: ['v1', 'missing', 'future', 'future-envelope', 'truncated', 'partial', 'unreadable'] })
  await writeFile(path.join(evidence, 'test-intent.md'), 'Public reader qualification only. These tests intentionally preserve detected old-reader failures, not future desired behavior. Unprivileged EACCES is MISSING if privilege drop is denied.\n')
  await sealArtifacts(evidence)
}, 120000)
const find = (reader: string, variant: string, operation: string) => report.cases.find((c: any) => c.reader === reader && c.variant === variant && c.operation === operation)

describe('actual public reader evidence', () => {
  // Red if an unrecognized report cell reaches arbitrary disk paths, or if the
  // source hash audit accepts a path outside its immutable source inputs.
  test('unknown cells and foreign source paths fail before evidence traversal', async () => {
    const copy = await mkdtemp(path.join(persistentRoot, 'S5a-untrusted-audit-'))
    await cp(evidence, copy, { recursive: true })
    const file = path.join(copy, 'store-preservation-baseline.json')
    const changed = JSON.parse(await readFile(file, 'utf8'))
    changed.cases[0].id = '../not-an-authorized-case'
    await writeFile(file, JSON.stringify(changed))
    const unknown = await auditEvidence(copy, ['outcome', 'manifest-evidence', 'manifest-store', 'versioned'], ['v1', 'missing', 'future', 'future-envelope', 'truncated', 'partial', 'unreadable'])
    expect(unknown.ok).toBe(false)
    expect(unknown.failures).toContain('Unexpected case outside the requested matrix')
    const foreign = path.join(copy, 'untrusted-source-input.txt')
    await writeFile(foreign, 'TEST-only foreign bytes')
    const original = JSON.parse(await readFile(file, 'utf8'))
    original.cases = report.cases
    original.inputPreservation.push({ path: foreign, sha256: 'untrusted', afterSha256: 'untrusted', unchanged: true })
    await writeFile(file, JSON.stringify(original))
    const denied = await auditEvidence(copy, ['outcome', 'manifest-evidence', 'manifest-store', 'versioned'], ['v1', 'missing', 'future', 'future-envelope', 'truncated', 'partial', 'unreadable'])
    expect(denied.ok).toBe(false)
    expect(denied.failures).toContain('Source input outside allowed immutable inputs')
  })

  // Red if a stale/tampered byte export or omitted required cell still yields a
  // valid evidence packet. Store unit tests do not verify captured handoff files.
  test('artifact audit rejects missing matrix cells and changed original bytes', async () => {
    const selectedReaders = ['outcome', 'manifest-evidence', 'manifest-store', 'versioned'] as const
    const selectedVariants = ['v1', 'missing', 'future', 'future-envelope', 'truncated', 'partial', 'unreadable'] as const
    expect((await auditEvidence(evidence, [...selectedReaders], [...selectedVariants])).ok).toBe(true)
    const copy = await mkdtemp(path.join(persistentRoot, 'S5a-audit-negative-'))
    await cp(evidence, copy, { recursive: true })
    const savedReport = JSON.parse(await readFile(path.join(copy, 'store-preservation-baseline.json'), 'utf8'))
    savedReport.cases.pop()
    await writeFile(path.join(copy, 'store-preservation-baseline.json'), JSON.stringify(savedReport))
    const incomplete = await auditEvidence(copy, [...selectedReaders], [...selectedVariants])
    expect(incomplete.ok).toBe(false)
    expect(incomplete.failures.some((f: string) => f.startsWith('Missing case '))).toBe(true)
    await writeFile(path.join(copy, 'store-preservation-baseline.json'), JSON.stringify(report))
    await writeFile(path.join(copy, 'cases/versioned-future-read/original.bin'), 'TEST-tampered-evidence')
    const tampered = await auditEvidence(copy, [...selectedReaders], [...selectedVariants])
    expect(tampered.ok).toBe(false)
    expect(tampered.failures).toContain('Byte export mismatch versioned-future-read/original.bin')
  })

  // Red if a truly missing file is accidentally materialized by reading, or a
  // retained manifest's watermark disappears. Unlike current unit tests this
  // reaches both public product reader paths on independently authored TEST bytes.
  test('known and truly missing product reads remain distinguishable by files and watermark', () => {
    for (const reader of ['manifest-evidence', 'manifest-store', 'versioned']) {
      const operation = reader === 'manifest-evidence' ? 'readRuntimeStoreManifestEvidenceData' : 'read'
      const known = find(reader, 'v1', operation), missing = find(reader, 'missing', operation)
      expect(known.qualification).toBe('OBSERVED')
      expect(missing.qualification).toBe('OBSERVED')
      expect(known.before.sha256).toBe(known.after.sha256)
      expect(missing.before).toBeNull()
      expect(missing.after).toBeNull()
      expect((known.observation.result.data ?? known.observation.result).highWatermark).toBe(7)
      expect((missing.observation.result.data ?? missing.observation.result).highWatermark).toBe(0)
      if (reader === 'versioned') expect(missing.observation.result.status).toBe('missing')
      if (reader !== 'manifest-evidence') {
        // Detect using the wrong constructor option (now instead of clock):
        // a real public write must use the explicitly supplied TEST clock.
        const updated = find(reader, 'missing', 'update').observation.result
        expect(reader === 'versioned' ? updated.envelope.updatedAt : updated.updatedAt).toBe('2026-10-01T00:00:00.000Z')
      }
    }
  })
  // Red if report drops real diagnostics/empty fallback or promotes it to PASS;
  // outcome writer tests do not qualify report status against the public query.
  test('future outcome empty fallback is captured as a detected failure, with original retained', () => {
    const c = find('outcome', 'future', 'query')
    expect(c.qualification).toBe('OBSERVED')
    expect(c.observation.result.record).toBeNull()
    expect(c.observation.result.diagnostics).toContain('OpenCode command outcome store shape was invalid; treating as empty.')
    expect(c.preservation.status).toBe('FAIL')
    expect(c.before.sha256).toBe(c.after.sha256)
  })
  // Red if only nested data is tested and ignored outer schema disappears from
  // the matrix; current product tests do not compare the two public boundaries.
  test('future envelope is ignored by evidence reader but rejected by versioned store', () => {
    const evidenceCase = find('manifest-evidence', 'future-envelope', 'readRuntimeStoreManifestEvidenceData')
    const versioned = find('versioned', 'future-envelope', 'read')
    expect(evidenceCase.observation.result.highWatermark).toBe(7)
    expect(evidenceCase.preservation.status).toBe('FAIL')
    expect(versioned.observation.result.ok).toBe(false)
    expect(versioned.observation.result.reason).toBe('future_schema')
    expect(versioned.preservation.status).toBe('FAIL')
  })
  // Red if an attempted update silently replaces a future file or reports success,
  // or if a quarantine copy is called preserve-only without retaining exact bytes.
  test('actual product future update veto and quarantine bytes are recorded separately', async () => {
    for (const reader of ['versioned', 'manifest-store']) {
      const c = find(reader, 'future', 'update')
      expect(c.qualification).toBe('OBSERVED')
      expect(c.observation.returned).toBe(false)
      expect(c.observation.error.reason).toBe('future_schema')
      expect(c.before.sha256).toBe(c.after.sha256)
      expect(c.preservation.status).toBe('FAIL') // quarantine violates preserve-only
      const quarantine = c.fileEffects.added.find((f: string) => f.endsWith('.quarantine'))
      expect(quarantine).toBeDefined()
      expect(await readFile(path.join(c.evidenceDir, quarantine))).toEqual(await readFile(path.join(c.evidenceDir, 'original.bin')))
    }
  })
  // Red if corrupt bytes become missing/loaded, or if byte exports are lossy.
  test('truncated and partial product authority has exact failures and original bytes', async () => {
    for (const [variant, reason] of [['truncated', 'invalid_json'], ['partial', 'invalid_data']]) {
      const c = find('versioned', variant!, 'read')
      expect(c.observation.result.reason).toBe(reason)
      expect(c.observation.result.ok).toBe(false)
      expect(await readFile(path.join(c.evidenceDir, 'after.bin'))).toEqual(await readFile(path.join(c.evidenceDir, 'original.bin')))
    }
  })
  // Red if chmod-as-root is labeled genuine EACCES or a missing child dependency
  // becomes a preservation PASS. This tests evidence honesty, not native support.
  test('unreadability requires nonroot actual EACCES; unavailable is explicit MISSING', () => {
    const c = find('versioned', 'unreadable', 'read')
    if (c.qualification === 'OBSERVED') {
      expect(c.observation.privilege.uidAfter).not.toBe(0)
      expect(c.observation.privilege.probe.code).toBe('EACCES')
      expect(c.observation.error.code).toBe('EACCES')
    } else {
      expect(c.preservation.status).toBe('MISSING')
      expect(['EPERM', 'EINVAL']).toContain(c.observation.privilege.dropError?.code)
      expect(c.observation.reason).toBe('Actual unprivileged EACCES unavailable')
    }
    expect(report.finalPreservationQualified).toBe(false)
    expect(report.fullDualSupportQualified).toBe(false)
    expect(report.cases.some((c: any) => c.preservation.status === 'PASS')).toBe(false)
  })
})
